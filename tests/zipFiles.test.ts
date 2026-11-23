// Unit cases for the dependency-free zip writer behind the Chrome Web Store upload (scripts/zip-files.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { zipBuffer, writeZip }: any = await import('../scripts/zip-files.mjs');

const unzip = (args: string[]) => spawnSync('unzip', args, { encoding: 'utf8' });

test('the zip holds every entry, in order, with its exact bytes, and passes unzip’s own check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-files-'));
  const file = path.join(dir, 'a.zip');
  const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]);
  writeZip(file, [
    { name: 'manifest.json', data: '{"a":1}\n' },
    { name: 'icons/icon-16.png', data: binary },
    { name: 'src/empty.mjs', data: '' },
  ]);
  assert.equal(unzip(['-tq', file]).status, 0);
  assert.deepEqual(unzip(['-Z1', file]).stdout.trim().split('\n'), ['manifest.json', 'icons/icon-16.png', 'src/empty.mjs']);
  assert.equal(unzip(['-p', file, 'manifest.json']).stdout, '{"a":1}\n');
  const out = spawnSync('unzip', ['-p', file, 'icons/icon-16.png']);
  assert.deepEqual(out.stdout, binary);
  assert.equal(unzip(['-p', file, 'src/empty.mjs']).stdout, '');
});

test('the same files give the same bytes (fixed timestamps); an empty zip is a valid empty archive', () => {
  const entries = [{ name: 'x.txt', data: 'same' }];
  assert.deepEqual(zipBuffer(entries), zipBuffer(entries));
  const empty = zipBuffer([]);
  assert.equal(empty.length, 22);
  assert.equal(empty.readUInt32LE(0), 0x06054b50);
});
