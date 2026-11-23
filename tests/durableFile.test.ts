// Durable atomic publication syncs the file and its directory before returning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeDurable } = require('../electron/platform/durableFile.cjs');

test('syncs file before rename and directory before success', () => {
  const calls: string[] = [];
  const io = {
    statSync: () => ({ mode: 0o640 }),
    openSync: (p: string, flags: string, mode?: number) => {
      calls.push(`open:${p}:${flags}:${mode}`);
      return p === '/data' ? 2 : 1;
    },
    writeSync: (fd: number, data: Buffer, offset: number, length: number) => {
      calls.push(`write:${fd}:${data.subarray(offset, offset + length).toString()}`);
      return length;
    },
    fchmodSync: (fd: number, mode: number) => calls.push(`chmod:${fd}:${mode}`),
    fsyncSync: (fd: number) => calls.push(`sync:${fd}`),
    closeSync: (fd: number) => calls.push(`close:${fd}`),
    renameSync: (a: string, b: string) => calls.push(`rename:${a}:${b}`),
    rmSync: (p: string) => calls.push(`remove:${p}`),
  };
  writeDurable('/data/state', 'bytes', io, undefined, () => 'unique');
  assert.deepEqual(calls, [
    'open:/data/.mopilot-unique.tmp:wx:416',
    'write:1:bytes',
    'chmod:1:416',
    'sync:1',
    'close:1',
    'rename:/data/.mopilot-unique.tmp:/data/state',
    'open:/data:r:undefined',
    'sync:2',
    'close:2',
  ]);
});

test('file and directory sync failures reject, close descriptors and clean only unpublished temporary files', () => {
  for (const failure of ['write', 'fileSync', 'rename', 'dirOpen', 'dirSync']) {
    const calls: string[] = [];
    const act = (name: string) => {
      calls.push(name);
      if (name === failure) throw new Error(failure);
    };
    const io = {
      statSync: () => undefined,
      openSync: (p: string) => {
        if (p === '/data') {
          act('dirOpen');
          return 2;
        }
        act('fileOpen');
        return 1;
      },
      writeSync: (_fd: number, _data: Buffer, _offset: number, length: number) => (act('write'), length),
      fchmodSync: () => {},
      fsyncSync: (fd: number) => act(fd === 1 ? 'fileSync' : 'dirSync'),
      closeSync: (fd: number) => calls.push(`close${fd}`),
      renameSync: () => act('rename'),
      rmSync: () => calls.push('remove'),
    };
    assert.throws(() => writeDurable('/data/state', 'bytes', io, 0o600, () => 'id'), new RegExp(failure));
    assert.equal(calls.includes('remove'), !['dirOpen', 'dirSync'].includes(failure));
    assert.equal(calls.includes('close1'), true);
    assert.equal(calls.includes('close2'), failure === 'dirSync');
  }
});

test('a new file uses the default mode and exclusive temporary creation', () => {
  let selectedMode = 0;
  const io = {
    statSync: () => undefined,
    openSync: (p: string, _: string, mode: number) => {
      if (p !== '/data') selectedMode = mode;
      return 1;
    },
    writeSync: (_fd: number, _data: Buffer, _offset: number, length: number) => length,
    fchmodSync() {},
    fsyncSync() {},
    closeSync() {},
    renameSync() {},
    rmSync() {},
  };
  writeDurable('/data/state', 'bytes', io, undefined, () => 'id');
  assert.equal(selectedMode, 0o666);
});

test('partial descriptor writes complete the buffer and a zero-progress write refuses publication', () => {
  const slices: string[] = [];
  let renamed = false;
  let removed = false;
  const io = {
    statSync: () => undefined,
    openSync: () => 1,
    writeSync: (_fd: number, data: Buffer, offset: number, length: number) => {
      const count = Math.min(2, length);
      slices.push(data.subarray(offset, offset + count).toString());
      return count;
    },
    fchmodSync() {},
    fsyncSync() {},
    closeSync() {},
    renameSync: () => {
      renamed = true;
    },
    rmSync: () => {
      removed = true;
    },
  };
  writeDurable('/data/state', Buffer.from('abcdef'), io, 0o600, () => 'partial');
  assert.deepEqual(slices, ['ab', 'cd', 'ef']);
  assert.equal(renamed, true);
  renamed = false;
  io.writeSync = () => 0;
  assert.throws(() => writeDurable('/data/state', 'bytes', io, 0o600, () => 'stalled'), /completely/);
  assert.equal(renamed, false);
  assert.equal(removed, true);
  writeDurable('/data/empty', Buffer.alloc(0), io, 0o600, () => 'empty');
  assert.equal(renamed, true);
});

test('private files keep owner-only mode and an exclusive-open collision never removes another file', () => {
  const { keepPrivate } = require('../electron/platform/privateFiles.cjs');
  keepPrivate('/private-consent-test');
  let mode = 0;
  let removed = false;
  const io = {
    statSync: () => ({ mode: 0o666 }),
    openSync: (_p: string, _flags: string, value: number) => {
      mode = value;
      throw new Error('collision');
    },
    rmSync: () => {
      removed = true;
    },
  };
  assert.throws(() => writeDurable('/private-consent-test/state', 'x', io, undefined, () => 'id'), /collision/);
  assert.equal(mode, 0o600);
  assert.equal(removed, false);
  io.statSync = () => undefined as any;
  assert.throws(() => writeDurable('/private-consent-test/new', 'x', io, undefined, () => 'id'), /collision/);
  assert.equal(mode, 0o600);
});
