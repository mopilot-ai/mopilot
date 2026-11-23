// Atomic filesystem writes: permissions, temporary-file lifecycle and failure reporting.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { writePrivate } = createRequire(import.meta.url)('../electron/platform/fsutil.cjs');

test('private writes do not inherit permissive permissions from a stale temporary file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-private-write-'));
  const file = path.join(dir, 'private.json');
  const stale = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(stale, 'stale');
    fs.chmodSync(stale, 0o644);
    writePrivate(file, 'secret');
    assert.equal(fs.readFileSync(file, 'utf8'), 'secret');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed private writes retain the previous file and remove their temporary data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-private-write-'));
  const file = path.join(dir, 'private.json');
  fs.writeFileSync(file, 'original');
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('rename failed');
  });
  try {
    assert.throws(() => writePrivate(file, 'secret'), /rename failed/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['private.json']);
  } finally {
    rename.mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write failures close the owned descriptor and remove partial temporary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-private-write-'));
  const file = path.join(dir, 'private.json');
  let fd = -1;
  const write = mock.method(fs, 'writeFileSync', (value: any) => {
    fd = value;
    throw new Error('disk full');
  });
  try {
    assert.throws(() => writePrivate(file, 'secret'), /disk full/);
    assert.throws(() => fs.fstatSync(fd), /bad file descriptor/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    write.mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
