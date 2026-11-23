// electron/platform/fs.cjs: fs:* IPC for the file tree and instruction files, in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fsp = require('../electron/platform/fs.cjs');

function tmp(t: any) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsplat-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function ipc() {
  const h = new Map<string, (...a: any[]) => any>();
  fsp.register({ handle: (ch: string, f: any) => h.set(ch, f) });
  return (ch: string, ...a: any[]) => h.get(ch)!({}, ...a);
}

test('fs:readDir lists entries, following directory symlinks; unreadable or relative paths are []', async (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'a.txt'), '');
  fs.symlinkSync(path.join(d, 'sub'), path.join(d, 'linkdir'));
  fs.symlinkSync(path.join(d, 'gone'), path.join(d, 'broken'));
  fs.symlinkSync(path.join(d, 'a.txt'), path.join(d, 'linkfile'));
  const call = ipc();
  const out = (await call('fs:readDir', d)).sort((x: any, y: any) => x.fileName.localeCompare(y.fileName));
  assert.deepEqual(out, [
    { fileName: 'a.txt', isDirectory: false },
    { fileName: 'broken', isDirectory: false },
    { fileName: 'linkdir', isDirectory: true },
    { fileName: 'linkfile', isDirectory: false },
    { fileName: 'sub', isDirectory: true },
  ]);
  assert.deepEqual(await call('fs:readDir', path.join(d, 'missing')), []);
  assert.deepEqual(await call('fs:readDir', 'relative'), []);
  assert.deepEqual(await call('fs:readDir', 42), []);
});

test('fs:remove removes trees, tolerates missing paths, refuses roots and relative paths', (t) => {
  const d = tmp(t);
  fs.mkdirSync(path.join(d, 'tree/deep'), { recursive: true });
  const call = ipc();
  assert.deepEqual(call('fs:remove', path.join(d, 'tree')), { ok: true });
  assert.equal(fs.existsSync(path.join(d, 'tree')), false);
  assert.deepEqual(call('fs:remove', path.join(d, 'tree')), { ok: true });
  assert.deepEqual(call('fs:remove', '/'), { ok: false, error: 'invalid path' });
  assert.deepEqual(call('fs:remove', 'x'), { ok: false, error: 'invalid path' });
  assert.deepEqual(call('fs:remove', null), { ok: false, error: 'invalid path' });
});

test('fs:remove reports the error when removal fails', (t) => {
  const rm = t.mock.method(fs, 'rmSync', () => {
    throw new Error('EBUSY');
  });
  assert.deepEqual(ipc()('fs:remove', '/some/abs'), { ok: false, error: 'The file is in use.' });
  rm.mock.mockImplementation(() => {
    throw 'odd';
  });
  assert.deepEqual(ipc()('fs:remove', '/some/abs'), { ok: false, error: 'Odd.' });
});

test('fs:writeText writes, and reports a failure instead of throwing', (t) => {
  const d = tmp(t);
  const call = ipc();
  assert.deepEqual(call('fs:writeText', path.join(d, 'n/AGENTS.md'), 'hi'), { ok: true });
  assert.equal(fs.readFileSync(path.join(d, 'n/AGENTS.md'), 'utf8'), 'hi');
  fs.writeFileSync(path.join(d, 'file'), '');
  const r = call('fs:writeText', path.join(d, 'file/under/x.md'), 'hi');
  assert.equal(r.ok, false);
  // a sentence, never the errno code or the path (#1863)
  assert.match(r.error, /^(Not a directory|It already exists)\.$/);
  t.mock.method(fs, 'mkdirSync', () => {
    throw 'odd';
  });
  assert.deepEqual(call('fs:writeText', path.join(d, 'y.md'), 'hi'), { ok: false, error: 'Odd.' });
  assert.deepEqual(call('fs:writeText', 'rel.md', 'hi'), { ok: false, error: 'invalid path' });
  assert.deepEqual(call('fs:writeText', path.join(d, 'y.md'), 5), { ok: false, error: 'invalid path' });
});

test('fs:configRoots names the harness config folders', () => {
  const r = ipc()('fs:configRoots');
  assert.equal(r.home, os.homedir());
  assert.equal(typeof r.codexHome, 'string');
  assert.equal(typeof r.claudeRoot, 'string');
});

test('fs:remove refuses alternate POSIX root spellings before attempting removal', (t) => {
  const rm = t.mock.method(fs, 'rmSync', () => undefined);
  const call = ipc();
  for (const p of ['//', '/./', '/folder/..', '/folder/../']) {
    assert.deepEqual(call('fs:remove', p), { ok: false, error: 'invalid path' }, p);
  }
  assert.equal(rm.mock.callCount(), 0);
  assert.deepEqual(call('fs:remove', '/folder/../file'), { ok: true });
  assert.equal(rm.mock.callCount(), 1);
});

test('fs:remove refuses alternate Windows drive and UNC roots before attempting removal', (t) => {
  t.mock.method(path, 'isAbsolute', path.win32.isAbsolute);
  t.mock.method(path, 'resolve', path.win32.resolve);
  t.mock.method(path, 'parse', path.win32.parse);
  const rm = t.mock.method(fs, 'rmSync', () => undefined);
  const call = ipc();
  for (const p of ['C:/', 'C:\\folder\\..', 'C:\\folder\\..\\', '\\\\server\\share\\.', '\\\\server\\share\\folder\\..']) {
    assert.deepEqual(call('fs:remove', p), { ok: false, error: 'invalid path' }, p);
  }
  assert.equal(rm.mock.callCount(), 0);
  assert.deepEqual(call('fs:remove', 'C:\\folder\\..\\file'), { ok: true });
  assert.equal(rm.mock.callCount(), 1);
});
