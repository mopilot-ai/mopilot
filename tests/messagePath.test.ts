// electron/platform/messagePath.cjs: a path a reply names resolves to the file or folder there ("~" is home, a
// relative path is in the chat's folder), or null for nothing there, an unreadable path or text that is no path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveMessagePath, MAX_PATH } = require('../electron/platform/messagePath.cjs');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'message-path-')));
const home = path.join(tmp, 'home');
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(home, 'Downloads', 'film v2'), { recursive: true });
fs.writeFileSync(path.join(home, 'Downloads', 'film_9x16.mp4'), '');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src', 'a.ts'), '');

test('"~" is the home folder: a folder (its trailing slash dropped), a file, home itself', async () => {
  assert.deepEqual(await resolveMessagePath('~/Downloads/film v2/', repo, home), {
    path: path.join(home, 'Downloads', 'film v2'),
    kind: 'dir',
  });
  assert.deepEqual(await resolveMessagePath('~/Downloads/film_9x16.mp4', null, home), {
    path: path.join(home, 'Downloads', 'film_9x16.mp4'),
    kind: 'file',
  });
  assert.deepEqual(await resolveMessagePath('~', null, home), { path: home, kind: 'dir' });
  // "~user" is no home folder of ours: a relative name in the chat's folder, which has none
  assert.equal(await resolveMessagePath('~Downloads', repo, home), null);
});

test('a relative path is in the chat folder and needs one; an absolute path needs none', async () => {
  assert.deepEqual(await resolveMessagePath('src/a.ts', repo, home), { path: path.join(repo, 'src', 'a.ts'), kind: 'file' });
  assert.deepEqual(await resolveMessagePath('./src/../src/', repo, home), { path: path.join(repo, 'src'), kind: 'dir' });
  assert.equal(await resolveMessagePath('src/a.ts', null, home), null);
  assert.equal(await resolveMessagePath('src/a.ts', 'relative/cwd', home), null);
  assert.deepEqual(await resolveMessagePath(path.join(repo, 'src', 'a.ts'), undefined, home), {
    path: path.join(repo, 'src', 'a.ts'),
    kind: 'file',
  });
  assert.deepEqual(await resolveMessagePath('/', null), { path: '/', kind: 'dir' });
});

test('nothing there, something that is neither file nor folder, and text that is no path are null', async () => {
  assert.equal(await resolveMessagePath('src/missing.ts', repo, home), null);
  assert.equal(await resolveMessagePath('/dev/null', repo, home), null);
  for (const text of ['', 'a\0b', 'x'.repeat(MAX_PATH + 1), 42, null, undefined])
    assert.equal(await resolveMessagePath(text, repo, home), null);
  // the real home folder is the default
  assert.equal((await resolveMessagePath('~', null))?.path, os.homedir());
});

test('a stat that never answers (a stalled network mount) reads as nothing there after the timeout', async () => {
  const hung = () => new Promise<never>(() => {});
  assert.equal(await resolveMessagePath('/Volumes/NAS/film.mp4', null, home, { stat: hung, timeoutMs: 5 }), null);
  // a stat that answers in time is used as is
  const quick = async () => fs.statSync(repo);
  assert.deepEqual(await resolveMessagePath('/elsewhere', null, home, { stat: quick, timeoutMs: 1000 }), {
    path: '/elsewhere',
    kind: 'dir',
  });
});
