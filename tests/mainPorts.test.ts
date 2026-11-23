// electron/platform/ports: fs and proc are node:fs and node:child_process until a test installs a fake, each use reads
// what is installed then, and null puts the real one back; the shared fakes (tests/support/ports) override only what they name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeFs } from './support/ports/fs.ts';
import { useFakeProc } from './support/ports/proc.ts';

const require = createRequire(import.meta.url);
// the CommonJS modules the ports hold (not the ESM namespaces, which are other objects)
const nodeFs = require('node:fs');
const childProcess = require('node:child_process');
const { fs, installFs } = require('../electron/platform/ports/fs.cjs');
const { proc, installProc } = require('../electron/platform/ports/proc.cjs');

test('the ports are node:fs and node:child_process until something else is installed', () => {
  assert.equal(fs.existsSync, nodeFs.existsSync);
  assert.equal(fs.promises.readFile, nodeFs.promises.readFile);
  assert.equal(proc.spawn, childProcess.spawn);
});

test('an installed implementation is read at each use, and null puts the real one back', () => {
  const fake = { existsSync: () => 'fake' } as any;
  const previous = installFs(fake);
  assert.equal(previous, nodeFs);
  assert.equal(fs.existsSync('/x'), 'fake');
  assert.equal(installFs(null), fake);
  assert.equal(fs.existsSync, nodeFs.existsSync);
  const spawned = { spawn: () => 'child' } as any;
  assert.equal(installProc(spawned), childProcess);
  assert.equal(proc.spawn('x'), 'child');
  assert.equal(installProc(null), spawned);
  assert.equal(proc.spawn, childProcess.spawn);
});

test('the shared fakes replace only what they name, promises included, and are taken out after the test', async (t) => {
  await t.test('fs', (sub) => {
    useFakeFs(sub, { existsSync: () => true, promises: { readFile: async () => 'faked' } });
    assert.equal(fs.existsSync('/no/such/file'), true);
    assert.equal(fs.readdirSync, nodeFs.readdirSync);
    assert.equal(fs.promises.stat, nodeFs.promises.stat);
    return fs.promises.readFile('/x').then((text: string) => assert.equal(text, 'faked'));
  });
  assert.equal(fs.existsSync, nodeFs.existsSync);
  await t.test('proc', (sub) => {
    useFakeProc(sub, { execFile: () => 'faked' });
    assert.equal(proc.execFile(), 'faked');
    assert.equal(proc.spawn, childProcess.spawn);
  });
  assert.equal(proc.execFile, childProcess.execFile);
});
