// Atomic filesystem writes: permissions, temporary-file lifecycle and failure reporting.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { writePrivate, writeAtomic } = createRequire(import.meta.url)('../electron/platform/fsutil.cjs');

test('write and rename errors survive secondary cleanup failures', () => {
  for (const write of [writePrivate, writeAtomic]) {
    for (const stage of ['write', 'rename']) {
      const primary = new Error(`${stage} failed`);
      const cleanup = new Error('cleanup failed');
      const mocks = [
        mock.method(fs, 'mkdirSync', () => undefined),
        mock.method(fs, 'openSync', () => 7),
        mock.method(fs, 'writeFileSync', () => {
          if (stage === 'write') throw primary;
        }),
        mock.method(fs, 'renameSync', () => {
          throw primary;
        }),
        mock.method(fs, 'closeSync', () => {
          if (stage === 'write') throw cleanup;
        }),
        mock.method(fs, 'rmSync', () => {
          throw cleanup;
        }),
      ];
      try {
        assert.throws(
          () => write('/fake/file', 'data'),
          (error) => error === primary,
        );
      } finally {
        for (const method of mocks) method.mock.restore();
      }
    }
  }
});

test('cleanup failures after successful operations remain visible', () => {
  const cleanup = new Error('close failed');
  const mocks = [
    mock.method(fs, 'openSync', () => 7),
    mock.method(fs, 'writeFileSync', () => undefined),
    mock.method(fs, 'closeSync', () => {
      throw cleanup;
    }),
    mock.method(fs, 'rmSync', () => undefined),
  ];
  try {
    assert.throws(
      () => writePrivate('/fake/file', 'data'),
      (error) => error === cleanup,
    );
  } finally {
    for (const method of mocks) method.mock.restore();
  }
});

test('temporary-file cleanup errors are reported after a successful rename', () => {
  const cleanup = new Error('temporary cleanup failed');
  const mocks = [
    mock.method(fs, 'openSync', () => 7),
    mock.method(fs, 'writeFileSync', () => undefined),
    mock.method(fs, 'closeSync', () => undefined),
    mock.method(fs, 'renameSync', () => undefined),
    mock.method(fs, 'rmSync', () => {
      throw cleanup;
    }),
  ];
  try {
    assert.throws(
      () => writePrivate('/fake/file', 'data'),
      (error) => error === cleanup,
    );
  } finally {
    for (const method of mocks) method.mock.restore();
  }
});

test('writeAtomic: two writes in the same millisecond use their own temporary files', (t) => {
  t.mock.method(Date, 'now', () => 1);
  const temps: string[] = [];
  const fileFs = {
    statSync: () => undefined,
    mkdirSync: () => undefined,
    writeFileSync: (p: string) => temps.push(p),
    renameSync: () => undefined,
    rmSync: () => undefined,
  };
  writeAtomic('/fake/state.json', 'a', fileFs);
  writeAtomic('/fake/state.json', 'b', fileFs);
  assert.equal(temps.length, 2);
  assert.notEqual(temps[0], temps[1]);
  for (const p of temps) assert.match(p, /^\/fake\/\.mopilot-\d+-[0-9a-f-]{36}\.tmp$/);
});

const { readStateFile } = createRequire(import.meta.url)('../electron/platform/fsutil.cjs');
const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');

test('a failed atomic write records the temporary file it could not remove, and throws the write error', () => {
  clearIgnored();
  const primary = new Error('write failed');
  const mocks = [
    mock.method(fs, 'mkdirSync', () => undefined),
    mock.method(fs, 'writeFileSync', () => {
      throw primary;
    }),
    mock.method(fs, 'rmSync', () => {
      throw new Error('EBUSY: resource busy');
    }),
  ];
  try {
    assert.throws(
      () => writeAtomic('/fake/file', 'data'),
      (error) => error === primary,
    );
  } finally {
    for (const method of mocks) method.mock.restore();
  }
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['remove a temporary file after a failed write', 'EBUSY: resource busy']],
  );
});

test('readStateFile: a missing state file is null and not recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-state-'));
  clearIgnored();
  assert.equal(readStateFile(path.join(dir, 'none.json'), 'the list'), null);
  assert.deepEqual(recentIgnored(), []);
  fs.writeFileSync(path.join(dir, 'ok.json'), '{"a":1}');
  assert.deepEqual(readStateFile(path.join(dir, 'ok.json'), 'the list'), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readStateFile: an unreadable state file is kept aside before the caller saves over it, and recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ "accounts": [ torn');
  clearIgnored();
  assert.equal(readStateFile(file, 'the list'), null);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{ "accounts": [ torn');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the list'],
  );
  // corrupt again later: the oldest copy, from before the defaults were saved over the file, is kept
  fs.writeFileSync(file, '{ later');
  clearIgnored();
  assert.equal(readStateFile(file, 'the list'), null);
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{ "accounts": [ torn');
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the list'],
  );
  // a file that can't even be copied aside (a folder in its place) is recorded too
  clearIgnored();
  const folder = path.join(dir, 'folder.json');
  fs.mkdirSync(folder);
  assert.throws(
    () => readStateFile(folder, 'the folder'),
    (e: any) => e.code === 'EISDIR',
  );
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the folder', 'keep a copy of the folder that could not be read', 'check a retained recovery copy'],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const mode of [0o600, 0o751]) {
  test(`atomic replacement preserves existing mode ${mode.toString(8)}`, { skip: process.platform === 'win32' }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-mode-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'existing');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, mode);
    writeAtomic(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(fs.statSync(file).mode & 0o777, mode);
    assert.deepEqual(fs.readdirSync(dir), ['existing']);
  });
}

test('atomic replacement preserves access bits even under a restrictive creation umask', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-umask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'existing');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o751);
  const previous = process.umask(0o077);
  try {
    writeAtomic(file, 'new');
    assert.equal(fs.statSync(file).mode & 0o777, 0o751);
    const fresh = path.join(dir, 'fresh');
    writeAtomic(fresh, 'new');
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
  }
});

test('unreadable file metadata stops an atomic write before any mutation', (t) => {
  const failure = Object.assign(new Error('metadata denied'), { code: 'EACCES' });
  t.mock.method(fs, 'statSync', () => {
    throw failure;
  });
  const write = t.mock.method(fs, 'writeFileSync', () => undefined);
  const mkdir = t.mock.method(fs, 'mkdirSync', () => undefined);
  assert.throws(
    () => writeAtomic('/fake/file', 'new'),
    (error) => error === failure,
  );
  assert.equal(write.mock.callCount(), 0);
  assert.equal(mkdir.mock.callCount(), 0);
});

test('failed permission restoration keeps the original file and cleans up the replacement', { skip: process.platform === 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-chmod-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'existing');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o600);
  const failure = new Error('chmod failed');
  t.mock.method(fs, 'chmodSync', () => {
    throw failure;
  });
  assert.throws(
    () => writeAtomic(file, 'new'),
    (error) => error === failure,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['existing']);
});

test('a directory or symlink at the backup path cannot count as a saved copy of corrupt state', (t) => {
  const { readStateFile } = createRequire(import.meta.url)('../electron/platform/fsutil.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'other-backup');
  fs.writeFileSync(target, 'unrelated');
  for (const kind of ['directory', 'symlink']) {
    const file = path.join(dir, `${kind}.json`);
    fs.writeFileSync(file, '{torn');
    if (kind === 'directory') fs.mkdirSync(`${file}.unreadable`);
    else fs.symlinkSync(target, `${file}.unreadable`);
    assert.throws(() => readStateFile(file, 'the state'), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{torn');
    assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated');
  }
});

test('failed recovery copies preserve the original read error, including an unverifiable old copy', (t) => {
  const { readStateFile } = createRequire(import.meta.url)('../electron/platform/fsutil.cjs');
  const primary = Object.assign(new Error('read failed'), { code: 'EIO' });
  let copyError: any;
  t.mock.method(fs, 'readFileSync', () => {
    throw primary;
  });
  t.mock.method(fs, 'copyFileSync', () => {
    throw copyError;
  });
  t.mock.method(fs, 'lstatSync', () => {
    throw new Error('cannot check copy');
  });
  for (copyError of [Object.assign(new Error('backup exists'), { code: 'EEXIST' }), new Error('copy failed'), null, undefined])
    assert.throws(
      () => readStateFile('/fake/state.json', 'the state'),
      (e) => e === primary,
    );
});

for (const [name, write] of [
  ['atomic', writeAtomic],
  ['private', writePrivate],
] as const) {
  test(`${name} writes support long valid destination names and remove only their own temporary file`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-long-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'x'.repeat(240));
    const unrelated = path.join(dir, '.mopilot-unrelated.tmp');
    fs.writeFileSync(file, 'old');
    fs.writeFileSync(unrelated, 'keep');
    write(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(unrelated), path.basename(file)].sort());
  });
}
