// File search in a chat's folder on the Host (host/src/hostSearch.mjs, #4103): ranked by name, from ripgrep or else git, the query never an argument of a command, bounded, and only inside the roots.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostSearch, runRipgrep, scoreOf } from '../host/src/hostSearch.mjs';
// @ts-ignore: plain ESM without declarations
import { runGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { callHost, startServer } from '../host/src/server.mjs';
// @ts-ignore: plain ESM without declarations
import { createPaths } from '../host/src/paths.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-search-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root);
const hostFs = createHostFs({ roots: [root] });
const noRg = async () => ({ ok: false, stdout: '', spawnFailed: true });
const listing =
  (names: string[], extra: object = {}) =>
  async () => ({ ok: true, stdout: names.join('\0'), spawnFailed: false, ...extra });
const NAMES = ['docs/readme.md', 'src/main.ts', 'src/util/main_helper.ts', 'MAIN.md', 'lib/a_m_a_i_n.txt', 'other.txt'];

test('names are ranked: starts with the query, then holds it in its name, then in its path, then letters in order; case is ignored', async () => {
  const s = createHostSearch({ hostFs, rg: listing(NAMES) as any });
  const found = await s.search({ path: root, query: 'MAIN', limit: 50 });
  assert.deepEqual(found, { files: ['MAIN.md', 'src/main.ts', 'src/util/main_helper.ts', 'lib/a_m_a_i_n.txt'], truncated: false });
  assert.deepEqual((await s.search({ path: root, query: 'util', limit: 50 })).files, ['src/util/main_helper.ts']);
  assert.deepEqual((await s.search({ path: root, query: 'xyz', limit: 50 })).files, []);
  assert.equal(scoreOf('a/b.ts', ''), 1);
  assert.equal(scoreOf('src/main.ts', 'main'), 4);
  assert.equal(scoreOf('src/domain.ts', 'main'), 3);
  assert.equal(scoreOf('main/x.ts', 'main'), 2);
  assert.equal(scoreOf('m-a-i-n.ts', 'main'), 1);
  assert.equal(scoreOf('m-a.ts', 'main'), 0);
});

test('names of the same score and length are listed in path order', async () => {
  const s = createHostSearch({ hostFs, rg: listing(['b.ts', 'c.ts', 'a.ts']) as any });
  assert.deepEqual((await s.search({ path: root, query: '', limit: 50 })).files, ['a.ts', 'b.ts', 'c.ts']);
});

test('the answer is capped at the limit and says when more matched; an empty query lists the shortest paths first', async () => {
  const s = createHostSearch({ hostFs, rg: listing(NAMES) as any });
  assert.deepEqual(await s.search({ path: root, query: '', limit: 2 }), { files: ['MAIN.md', 'other.txt'], truncated: true });
  assert.equal((await s.search({ path: root, query: '', limit: 50 })).truncated, false);
  // a listing that was cut at its bound says so, and one past the most paths read is cut too
  assert.equal(
    (
      await createHostSearch({ hostFs, rg: listing(NAMES, { ok: false, cut: true }) as any }).search({
        path: root,
        query: 'main',
        limit: 50,
      })
    ).truncated,
    true,
  );
  const many = Array.from({ length: 200_001 }, (_, i) => `f${i}`);
  const huge = await createHostSearch({ hostFs, rg: listing(many) as any }).search({ path: root, query: 'f1', limit: 3 });
  assert.equal(huge.files.length, 3);
  assert.equal(huge.truncated, true);
});

test('without ripgrep git lists the tracked and the new files, not the ignored ones nor .git; and the query is never an argument', async () => {
  const dir = path.join(root, 'repo');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const g = (...args: string[]) =>
    assert.equal(spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd: dir }).status, 0, args.join(' '));
  g('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(dir, 'tracked.ts'), '1');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), '1');
  fs.writeFileSync(path.join(dir, 'sub', 'fresh.ts'), '1');
  g('add', 'tracked.ts', '.gitignore');
  const ran: string[][] = [];
  const s = createHostSearch({
    hostFs,
    rg: noRg as any,
    run: ((args: string[], o: any) => (ran.push(args), runGit(args, o))) as any,
  });
  assert.deepEqual((await s.search({ path: dir, query: '.ts', limit: 50 })).files.sort(), ['sub/fresh.ts', 'tracked.ts']);
  assert.deepEqual((await s.search({ path: dir, query: 'ignored', limit: 50 })).files, []);
  // a query that looks like an option is only text to match
  for (const query of ['--help', '-x', '--output=/tmp/x', '--'])
    assert.deepEqual((await s.search({ path: dir, query, limit: 50 })).files, []);
  assert.ok(ran.length > 0 && ran.every((args) => args.every((a) => !a.startsWith('--help') && a !== '-x' && !a.startsWith('--output'))));
  // a folder git cannot list and no ripgrep: no files, not an error; git cut at its bound: marked
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(await s.search({ path: plain, query: 'a', limit: 50 }), { files: [], truncated: false });
  const cutGit = createHostSearch({
    hostFs,
    rg: noRg as any,
    run: (async () => ({ ok: false, cut: true, stdout: 'a.ts\0b.ts\0' })) as any,
  });
  assert.deepEqual(await cutGit.search({ path: dir, query: 'ts', limit: 50 }), { files: ['a.ts', 'b.ts'], truncated: true });
});

test('a folder outside the roots is refused, also through a link', async () => {
  const s = createHostSearch({ hostFs, rg: listing(NAMES) as any });
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  await assert.rejects(s.search({ path: outside, query: 'a', limit: 5 }), (e: any) => e.code === 'outside_roots');
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link);
  await assert.rejects(s.search({ path: link, query: 'a', limit: 5 }), (e: any) => e.code === 'outside_roots');
});

test('the ripgrep run: its files, none found as an empty list, a failure or a missing binary as a failed run, and output past the bound cut', async () => {
  const bin = (name: string, body: string) => {
    const file = path.join(base, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const ok: any = await runRipgrep(root, bin('rg-ok', "printf 'a.ts\\0b.ts\\0'"));
  assert.deepEqual([ok.ok, ok.stdout.split('\0').filter(Boolean)], [true, ['a.ts', 'b.ts']]);
  assert.equal(((await runRipgrep(root, bin('rg-none', 'exit 1'))) as any).ok, true, 'no files is not a failure');
  assert.equal(((await runRipgrep(root, bin('rg-bad', 'echo no >&2; exit 2'))) as any).ok, false);
  const missing: any = await runRipgrep(root, path.join(base, 'no-such-rg'));
  assert.deepEqual([missing.ok, missing.spawnFailed], [false, true]);
  const flood: any = await runRipgrep(
    root,
    bin('rg-flood', 'exec yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  );
  assert.equal(flood.cut, true);
  assert.equal(flood.ok, false);
  // the listing is the one the search reads: with a bin that fails, the default falls through to git
  // a run the timeout ended is a timeout, not a missing ripgrep
  const slow: any = await runRipgrep(root, bin('rg-slow', 'exec sleep 30'), 100);
  assert.equal(slow.timedOut, true);
  assert.equal(typeof (await createHostSearch({ hostFs }).search({ path: root, query: 'zzz-no-such', limit: 5 })).truncated, 'boolean');
});

test('the socket serves fs.search with the roots, refuses a bad request, and is unknown on a Host without it', async () => {
  const paths = createPaths({ dataDir: path.join(base, 'sock'), env: {} });
  const dir = path.join(root, 'served');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'needle.ts'), '1');
  const server = await startServer({
    paths,
    dirs: { hostFs, hostGit: {}, hostSearch: createHostSearch({ hostFs, rg: listing(['needle.ts', 'hay.ts']) as any }) } as any,
  });
  try {
    const ok: any = await callHost(paths.socketPath, 'fs.search', { path: dir, query: 'needle' });
    assert.deepEqual(ok.result, { files: ['needle.ts'], truncated: false });
    assert.equal(((await callHost(paths.socketPath, 'fs.search', { path: '/etc', query: 'a' })) as any).code, 'outside_roots');
    assert.match(((await callHost(paths.socketPath, 'fs.search', { path: dir, query: 7 })) as any).error, /search/i);
  } finally {
    await server.close();
  }
  const bare = createPaths({ dataDir: path.join(base, 'sock2'), env: {} });
  const unwired = await startServer({ paths: bare });
  try {
    assert.match(((await callHost(bare.socketPath, 'fs.search', { path: dir, query: 'a' })) as any).error, /Unknown method/);
  } finally {
    await unwired.close();
  }
});

test('a listing the timeout ended is a refusal, not an empty answer: neither ripgrep nor git falls through to the other', async () => {
  const timedOutRg = createHostSearch({
    hostFs,
    rg: (async () => ({ ok: false, stdout: '', spawnFailed: false, timedOut: true })) as any,
    run: (async () => assert.fail('git must not run')) as any,
  });
  await assert.rejects(timedOutRg.search({ path: root, query: 'a', limit: 5 }), (e: any) => e.code === 'read_timed_out');
  const timedOutGit = createHostSearch({
    hostFs,
    rg: noRg as any,
    run: (async () => ({ ok: false, stdout: '', signal: 'SIGTERM' })) as any,
  });
  await assert.rejects(timedOutGit.search({ path: root, query: 'a', limit: 5 }), (e: any) => e.code === 'read_timed_out');
});
