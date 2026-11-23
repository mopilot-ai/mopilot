// A durable write syncs its folder where the system can, and on Windows, which refuses to flush a folder (EPERM), publishes
// the file without it: every writer that synced its folder by hand failed there after the rename had landed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { canSyncFolder, syncFolder, syncFolderAsync } = require('../electron/platform/folderSync.cjs');
const durableFile = require('../electron/platform/durableFile.cjs');
const remoteWrite = require('../electron/remote/durableWrite.cjs');
const momoWrite = require('../electron/gateway/durableWrite.cjs');
const { writePrivate } = require('../electron/platform/fsutil.cjs');

/** Runs `fn` as if on `platform` (the writers read process.platform), putting the real one back after. */
async function on<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
}

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' });

test('only Windows cannot sync a folder', () => {
  assert.equal(canSyncFolder('darwin'), true);
  assert.equal(canSyncFolder('linux'), true);
  assert.equal(canSyncFolder('win32'), false);
});

test('syncFolder opens, syncs and closes the folder on macOS and Linux, and touches nothing on Windows', async () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const calls: string[] = [];
    const io = {
      openSync: (p: string, flags: string) => (calls.push(`open:${p}:${flags}`), 7),
      fsyncSync: (fd: number) => calls.push(`sync:${fd}`),
      closeSync: (fd: number) => calls.push(`close:${fd}`),
    };
    syncFolder('/data', { fs: io, platform });
    const handle = { sync: async () => void calls.push('async-sync'), close: async () => void calls.push('async-close') };
    await syncFolderAsync('/data', {
      fs: { open: async (p: string, flags: string) => (calls.push(`async-open:${p}:${flags}`), handle) },
      platform,
    });
    assert.deepEqual(
      calls,
      platform === 'win32' ? [] : ['open:/data:r', 'sync:7', 'close:7', 'async-open:/data:r', 'async-sync', 'async-close'],
      platform,
    );
  }
});

test('a folder sync that fails still closes the folder and reports the failure', async () => {
  const calls: string[] = [];
  const io = {
    openSync: () => 3,
    fsyncSync: () => {
      throw eperm();
    },
    closeSync: (fd: number) => calls.push(`close:${fd}`),
  };
  assert.throws(() => syncFolder('/data', { fs: io, platform: 'linux' }), /EPERM/);
  const handle = {
    sync: async () => {
      throw eperm();
    },
    close: async () => void calls.push('async-close'),
  };
  await assert.rejects(syncFolderAsync('/data', { fs: { open: async () => handle }, platform: 'linux' }), /EPERM/);
  assert.deepEqual(calls, ['close:3', 'async-close']);
});

test("a close that fails after a failed folder sync leaves the sync's error, and one after a good sync is reported", async () => {
  const closeFails = () => {
    throw Object.assign(new Error('EBADF: bad file descriptor, close'), { code: 'EBADF' });
  };
  const io = (syncs: boolean) => ({
    openSync: () => 3,
    fsyncSync: () => {
      if (!syncs) throw eperm();
    },
    closeSync: closeFails,
  });
  assert.throws(() => syncFolder('/data', { fs: io(false), platform: 'linux' }), /EPERM/);
  assert.throws(() => syncFolder('/data', { fs: io(true), platform: 'linux' }), /EBADF/);
  const handle = (syncs: boolean) => ({
    sync: async () => {
      if (!syncs) throw eperm();
    },
    close: async () => closeFails(),
  });
  await assert.rejects(syncFolderAsync('/data', { fs: { open: async () => handle(false) }, platform: 'linux' }), /EPERM/);
  await assert.rejects(syncFolderAsync('/data', { fs: { open: async () => handle(true) }, platform: 'linux' }), /EBADF/);
});

test('the default fs and platform are the real ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-'));
  try {
    syncFolder(dir);
    await syncFolderAsync(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A promise fs (as fs.promises) that writes in memory and refuses to flush a folder, as Windows does. */
function windowsLikePromises(files: Map<string, string>, folders: Set<string>) {
  return {
    open: async (p: string) => {
      let text = '';
      return {
        write: async (t: string) => void (text += t),
        sync: async () => {
          if (folders.has(p)) throw eperm();
        },
        close: async () => {
          if (!folders.has(p)) files.set(p, text);
        },
      };
    },
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    rm: async (p: string) => void files.delete(p),
  };
}

test('Mobile Remote and MoMo durable writes publish on Windows, where a folder cannot be flushed', async () => {
  for (const { writeDurable } of [remoteWrite, momoWrite]) {
    const files = new Map<string, string>();
    const io = windowsLikePromises(files, new Set(['/data']));
    await on('win32', () => writeDurable(io, '/data/keys.json', 'sealed'));
    assert.deepEqual([...files], [['/data/keys.json', 'sealed']]);
    // elsewhere the folder is synced, and its failure is still reported
    await assert.rejects(
      on('linux', () => writeDurable(windowsLikePromises(new Map(), new Set(['/data'])), '/data/keys.json', 'sealed')),
      /EPERM/,
    );
  }
  // Mobile Remote's says the file was renamed into place before the folder sync failed (its callers read the new file)
  const failed = await on('linux', () =>
    remoteWrite.writeDurable(windowsLikePromises(new Map(), new Set(['/data'])), '/data/keys.json', 'sealed').then(
      () => null,
      (error: Error & { renamed?: boolean }) => error,
    ),
  );
  assert.match(String(failed?.message), /The renamed file could not be synced: EPERM/);
  assert.equal(failed?.renamed, true);
});

test('a durable state file publishes on Windows without opening its folder', async () => {
  const calls: string[] = [];
  const io = {
    statSync: () => undefined,
    openSync: (p: string) => {
      if (p === '/data') throw eperm();
      calls.push(`open:${p}`);
      return 1;
    },
    writeSync: (_fd: number, _data: Buffer, _offset: number, length: number) => length,
    fchmodSync: () => {},
    fsyncSync: (fd: number) => calls.push(`sync:${fd}`),
    closeSync: (fd: number) => calls.push(`close:${fd}`),
    renameSync: (a: string, b: string) => calls.push(`rename:${a}:${b}`),
    rmSync: (p: string) => calls.push(`remove:${p}`),
  };
  await on('win32', () => durableFile.writeDurable('/data/state', 'bytes', io, undefined, () => 'unique'));
  assert.deepEqual(calls, ['open:/data/.mopilot-unique.tmp', 'sync:1', 'close:1', 'rename:/data/.mopilot-unique.tmp:/data/state']);
});

test('a durable private file (sealed files, audio records) publishes on Windows without opening its folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-private-'));
  const file = path.join(dir, 'history.enc');
  const realOpen = fs.openSync;
  // as Windows: a folder opened for an fsync is refused
  const opened: string[] = [];
  fs.openSync = ((p: fs.PathLike, ...rest: any[]) => {
    opened.push(String(p));
    if (String(p) === dir) throw eperm();
    return (realOpen as any)(p, ...rest);
  }) as typeof fs.openSync;
  try {
    await on('win32', () => writePrivate(file, 'sealed', fs, { durable: true }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'sealed');
    assert.equal(opened.includes(dir), false);
  } finally {
    fs.openSync = realOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a deleted chat's Host outbox retires its inputs on every platform, syncing its folder where the system can", async () => {
  const { createOutbox } = require('../electron/host/outbox.cjs');
  for (const platform of ['linux', 'win32'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-outbox-'));
    try {
      const outbox = createOutbox({ dir });
      outbox.add('c1', { key: 'a', epoch: 1, options: { text: 'a' } });
      outbox.add('c1', { key: 'b', epoch: 1, options: { text: 'b' } });
      assert.deepEqual(await on(platform, () => outbox.retire('c1')), ['a', 'b'], platform);
      assert.deepEqual(outbox.pending('c1'), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
