// The folders a chat's host tools may reach (electron/capabilities/tools/sessionFolders.cjs): its working directory and the
// folders granted to it, a path inside them by its real path, and nothing a link or a look-alike character leads out of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createSessionFolders, expandHome, OUTSIDE } = require('../electron/capabilities/tools/sessionFolders.cjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-folders-')));
const project = path.join(root, 'project');
const granted = path.join(root, 'granted');
const elsewhere = path.join(root, 'elsewhere');
for (const d of [project, granted, elsewhere]) fs.mkdirSync(d);
fs.writeFileSync(path.join(project, 'a.ts'), 'x');
fs.writeFileSync(path.join(granted, 'g.ts'), 'x');
fs.writeFileSync(path.join(elsewhere, 'secret.ts'), 'x');
fs.symlinkSync(path.join(elsewhere, 'secret.ts'), path.join(project, 'out.ts'));
fs.symlinkSync(project, path.join(root, 'project-link'));

const make = (over: { cwd?: string | null; extra?: string[] } = {}) =>
  createSessionFolders({
    projectOf: async () => (over.cwd === undefined ? project : over.cwd),
    extraOf: () => over.extra ?? [granted],
    home: root,
  });
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: any) => e.code,
  );

test('the folders are the working directory first, then the granted ones that are absolute paths', async () => {
  assert.deepEqual(await make().folders('c'), [project, granted]);
  assert.deepEqual(await make({ cwd: null, extra: ['relative', granted] }).folders('c'), [granted]);
});

test('a path resolves by its real path inside a folder: relative, absolute, ~, through a link, and a granted folder', async () => {
  const s = make();
  assert.deepEqual(await s.resolve('c', 'a.ts'), { path: path.join(project, 'a.ts'), isDirectory: false });
  assert.deepEqual(await s.resolve('c', ' ./a.ts '), { path: path.join(project, 'a.ts'), isDirectory: false });
  assert.deepEqual(await s.resolve('c', path.join(root, 'project-link', 'a.ts')), { path: path.join(project, 'a.ts'), isDirectory: false });
  assert.deepEqual(await s.resolve('c', '~/granted/g.ts'), { path: path.join(granted, 'g.ts'), isDirectory: false });
  assert.deepEqual(await s.resolve('c', granted), { path: granted, isDirectory: true });
  assert.deepEqual(await s.resolve('c', '.'), { path: project, isDirectory: true });
});

test('a path outside the folders, missing, or reached through a link that leaves them is refused with the same words', async () => {
  const s = make();
  for (const p of [path.join(elsewhere, 'secret.ts'), 'out.ts', 'missing.ts', '../elsewhere/secret.ts', '/']) {
    await assert.rejects(s.resolve('c', p), (e: any) => e.code === 'not_found' && e.message === OUTSIDE, p);
  }
});

test('bad input is refused before anything is looked up', async () => {
  const s = make();
  for (const p of [undefined, '', '   ', 'a'.repeat(5000), 123]) assert.equal(await code(s.resolve('c', p)), 'invalid_args', String(p));
  // invisible and look-alike characters, which an approval card could not show
  for (const p of ['a​.ts', 'a⠀.ts', 'a .ts', 'a\n.ts', 'a‮.ts'])
    await assert.rejects(
      s.resolve('c', p),
      (e: any) => e.code === 'invalid_args' && /can't show unambiguously/.test(e.message),
      JSON.stringify(p),
    );
  // no working directory: only an absolute path can name anything
  const none = make({ cwd: null, extra: [] });
  await assert.rejects(none.resolve('c', 'a.ts'), /no working directory/);
  await assert.rejects(none.resolve('c', path.join(project, 'a.ts')), (e: any) => e.code === 'not_found');
});

test('~ is the home folder only at the start of a path', () => {
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('~/x', '/h'), path.join('/h', 'x'));
  assert.equal(expandHome('~x', '/h'), '~x');
  assert.equal(expandHome('/a/~', '/h'), '/a/~');
  assert.equal(expandHome('~'), os.homedir());
});

test('the default home folder is the real one', async () => {
  const s = createSessionFolders({ projectOf: async () => os.homedir(), extraOf: () => [] });
  assert.equal((await s.resolve('c', '~')).isDirectory, true);
});
