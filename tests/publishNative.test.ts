import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishNativeBinary } from '../scripts/publish-native.mjs';

test('native replacement signs before publication and preserves the old mapped inode', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'native-publish-test-'));
  let fd;
  try {
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'sage-mcp');
    writeFileSync(source, 'new executable');
    writeFileSync(destination, 'old executable');
    const oldInode = statSync(destination).ino;
    fd = openSync(destination, 'r');
    let signed = false;
    assert.equal(
      publishNativeBinary(source, destination, (staged) => {
        assert.equal(readFileSync(destination, 'utf8'), 'old executable');
        assert.equal(statSync(destination).ino, oldInode);
        assert.notEqual(statSync(staged).ino, oldInode);
        assert.equal(statSync(staged).mode & 0o777, 0o755);
        writeFileSync(staged, 'new signed executable');
        signed = true;
      }),
      destination,
    );
    assert.ok(signed);
    assert.equal(readFileSync(destination, 'utf8'), 'new signed executable');
    assert.notEqual(statSync(destination).ino, oldInode);
    assert.equal(readFileSync(fd, 'utf8'), 'old executable');
    assert.deepEqual(readdirSync(dir).sort(), ['sage-mcp', 'source']);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed signing preserves the working binary and removes staging files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'native-publish-test-'));
  try {
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'auth-command');
    writeFileSync(source, 'new');
    writeFileSync(destination, 'working');
    const oldInode = statSync(destination).ino;
    assert.throws(
      () =>
        publishNativeBinary(source, destination, () => {
          throw new Error('signature verification failed');
        }),
      /signature verification failed/,
    );
    assert.equal(statSync(destination).ino, oldInode);
    assert.equal(readFileSync(destination, 'utf8'), 'working');
    assert.deepEqual(readdirSync(dir).sort(), ['auth-command', 'source']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsigned packaging also publishes atomically and creates its output directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'native-publish-test-'));
  try {
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'nested', 'disclaim');
    writeFileSync(source, 'executable');
    publishNativeBinary(source, destination);
    assert.equal(readFileSync(destination, 'utf8'), 'executable');
    assert.equal(statSync(destination).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(path.dirname(destination)), ['disclaim']);
    assert.throws(() => publishNativeBinary(path.join(dir, 'missing'), destination), /ENOENT/);
    assert.ok(existsSync(destination));
    assert.deepEqual(readdirSync(path.dirname(destination)), ['disclaim']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
