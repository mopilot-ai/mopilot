// electron/platform/pathInside.cjs: the one "is this path inside that folder" check main uses, as written and by
// real paths, and the copies that now use it (plugins, the Chrome panel's skills, workspace overlap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lexicalInside } = require('../electron/platform/pathInside.cjs');
const { inside } = require('../electron/plugins/read.cjs');

test('a folder holds itself and its children; a sibling that only starts with dots is inside, ".." is not', () => {
  assert.equal(lexicalInside('/repo', '/repo'), true);
  assert.equal(lexicalInside('/repo', '/repo/a/b'), true);
  assert.equal(lexicalInside('/repo', '/repo/..notes'), true);
  assert.equal(lexicalInside('/repo', '/repo/../other'), false);
  assert.equal(lexicalInside('/repo', '/repository'), false);
});

test('Windows paths compare with the Windows path module, ignoring letter case', () => {
  assert.equal(lexicalInside('C:\\Repo', 'c:\\repo\\src', path.win32), true);
  assert.equal(lexicalInside('C:\\Repo', 'D:\\repo\\src', path.win32), false);
});

test("a plugin's file is inside by its real path: a link out of the folder is outside, a missing one throws", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inside-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  try {
    fs.mkdirSync(path.join(root, '..notes'));
    fs.symlinkSync(out, path.join(root, 'link'));
    assert.equal(await inside(root, path.join(root, '..notes')), true);
    assert.equal(await inside(root, path.join(root, 'link')), false);
    await assert.rejects(inside(root, path.join(root, 'gone')), { code: 'ENOENT' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
