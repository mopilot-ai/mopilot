// electron/platform/search.cjs: fuzzy ranking of file paths, and listing a folder with the bundled ripgrep.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { rank, listFiles, searchFiles, rgPath } = require('../electron/platform/search.cjs');
const { core } = require('../electron/platform/core.cjs');

const paths = (r: { path: string }[]) => r.map((x) => x.path);

test('a query matches as a case-insensitive subsequence, with the matched positions', async () => {
  const indices = async (query: string, file: string) => (await rank([file], query, { dirs: false }))[0]?.indices;
  assert.deepEqual(await indices('abc', 'xaxbxc'), [1, 3, 5]);
  assert.deepEqual(await indices('ABC', 'abc'), [0, 1, 2]);
  assert.equal(await indices('abd', 'abc'), undefined);
  assert.deepEqual(await indices('', 'abc'), []);
  const s = 'src/components/composer/Composer.tsx';
  const [hit] = await rank([s], 'comp', { dirs: false });
  assert.equal(
    hit.indices
      .map((i: number) => s[i])
      .join('')
      .toLowerCase(),
    'comp',
  );
  assert.equal(hit.indices[0], s.indexOf('Composer'));
});

test('ranking: exact basename, then word-start matches, then scattered ones', async () => {
  const files = [
    'src/lib/format.ts',
    'src/components/composer/Composer.tsx',
    'docs/compose-notes.md',
    'scripts/package.mjs',
    'src/components/panels/FilesPanel.tsx',
    'tests/cmp/o/s/e/r.ts',
  ];
  const r = await rank(files, 'composer', { dirs: false });
  assert.equal(r[0].path, 'src/components/composer/Composer.tsx');
  assert.ok(!paths(r).includes('src/lib/format.ts'));
  assert.equal(paths(await rank(files, 'filespanel', { dirs: false }))[0], 'src/components/panels/FilesPanel.tsx');
  // acronym-style query hits word starts
  assert.equal(
    paths(await rank(['src/fp.ts', 'src/components/panels/FilesPanel.tsx', 'src/ffffpppp.ts'], 'fp', { dirs: false }))[0],
    'src/fp.ts',
  );
});

test('a shorter path wins a tie, and an empty query lists the shortest paths first', async () => {
  const files = ['a/b/c/readme.md', 'readme.md', 'x/readme.md'];
  assert.deepEqual(paths(await rank(files, 'readme', { dirs: false })), ['readme.md', 'x/readme.md', 'a/b/c/readme.md']);
  assert.deepEqual(paths(await rank(files, '', { dirs: false, limit: 2 })), ['readme.md', 'x/readme.md']);
});

test('folders are offered once each, and spaces in the query are ignored', async () => {
  const r = await rank(['src/a.ts', 'src/b.ts', 'src/deep/c.ts'], 'src', { root: '/r' });
  const dirs = r.filter((x: any) => x.match_type === 'directory');
  assert.deepEqual(paths(dirs).sort(), ['src', 'src/deep']);
  assert.equal(r[0].root, '/r');
  assert.equal((await rank(['src/deep/c.ts'], 'deep c', { dirs: false })).length, 1);
});

test('the result cap applies', async () => {
  const files = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
  assert.equal((await rank(files, 'f', { limit: 7, dirs: false })).length, 7);
});

test('ripgrep lists files under a folder, honouring .gitignore and skipping .git', {
  skip: rgPath() === 'rg' && 'no bundled ripgrep',
}, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-')));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), '');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'hello-world.ts'), '');
  fs.writeFileSync(path.join(dir, '.env.example'), '');
  assert.deepEqual((await listFiles(dir)).sort(), ['.env.example', '.gitignore', 'src/hello-world.ts']);
  assert.equal((await listFiles(dir, { max: 1 })).length, 1);
  const { files } = await searchFiles(dir, 'hw');
  assert.equal(files[0].path, 'src/hello-world.ts');
  assert.deepEqual(await searchFiles('/nonexistent/folder', 'x'), { files: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rgPath prefers the ripgrep in Resources over any other', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-res-'));
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  fs.mkdirSync(path.join(dir, 'ripgrep'));
  fs.writeFileSync(path.join(dir, 'ripgrep', exe), '');
  const before = (process as any).resourcesPath;
  (process as any).resourcesPath = dir;
  try {
    assert.equal(rgPath(), path.join(dir, 'ripgrep', exe));
  } finally {
    (process as any).resourcesPath = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file listing preserves newlines and carriage returns inside filenames across output chunks', async () => {
  const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  const proc = Object.assign(new EventEmitter(), { stdout, kill() {} });
  const spawn = mock.method(childProcess, 'spawn', (_bin: string, args: string[]) => {
    assert.ok(args.includes('--null'));
    queueMicrotask(() => {
      stdout.emit('data', './notes/first\n');
      stdout.emit('data', 'second\r\nline.ts\0plain.ts\0');
      proc.emit('close', 0);
    });
    return proc;
  });
  try {
    assert.deepEqual(await listFiles('/project', { bin: 'mock-rg' }), ['notes/first\nsecond\r\nline.ts', 'plain.ts']);
  } finally {
    spawn.mock.restore();
  }
});

test('Unicode lowercase expansion keeps matches at positions in the original filename', async () => {
  const hits = await rank(['İx.ts', 'İ/İx.ts'], 'x', { dirs: false });
  for (const hit of hits) assert.equal(hit.path[hit.indices[0]], 'x');
});

test('a query cut in the middle of an emoji still searches', async () => {
  const hits = await rank(['src/app.ts', 'src/other.ts'], 'app\ud83d');
  assert.ok(Array.isArray(hits));
  assert.deepEqual(await rank(['src/app.ts'], '\ud83d'), await rank(['src/app.ts'], '\ufffd'));
});

test('a core that fails is said as such, and a search that fails leaves no listing behind', async (t) => {
  const addon = core();
  const dispatch = addon.dispatch.bind(addon);
  const failing = (route: string) =>
    t.mock.method(addon, 'dispatch', (asked: string, payload: Buffer) =>
      asked === route ? Promise.reject(new Error('no')) : dispatch(asked, payload),
    );
  const open = failing('rank.open');
  await assert.rejects(rank(['a.ts'], 'a'), /File search is unavailable/);
  open.mock.restore();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-fails-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.ts'), '');
  const search = failing('rank.search');
  await assert.rejects(rank(['a.ts'], 'a'), /File search is unavailable/);
  await assert.rejects(searchFiles(dir, 'a'), /File search is unavailable/);
  search.mock.restore();
  assert.deepEqual(
    (await searchFiles(dir, 'a')).files.map((f: any) => f.path),
    ['a.ts'],
  );
});

test('a listing the core no longer holds is noted as it is let go, and the search still answers', async (t) => {
  const { recentIgnored } = require('../electron/ignored.cjs');
  const addon = core();
  const dispatch = addon.dispatch.bind(addon);
  const closed = new Promise<void>((resolve) =>
    t.mock.method(addon, 'dispatch', (asked: string, payload: Buffer) =>
      asked === 'rank.close' ? (setImmediate(resolve), Promise.reject(new Error('no listing'))) : dispatch(asked, payload),
    ),
  );
  assert.deepEqual(paths(await rank(['a.ts'], 'a', { dirs: false })), ['a.ts']);
  await closed;
  assert.ok(recentIgnored().some((e: any) => e.context === 'close a file listing' && e.message === 'no listing'));
});
