// What a write on a machine must never reach (#5066 review): a path naming the folder itself, a folder name read as a pattern, a commit that takes what is staged outside the folder, two writes racing on one index, and a write that outlives the app's wait.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostWrite } from '../host/src/hostWrite.mjs';
// @ts-ignore: plain ESM without declarations
import { runGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { parseParams } from '../shared/host/schema.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-write-guards-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root);
const hostFs = createHostFs({ roots: [root] });
const g = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trimEnd();
};
let n = 0;
const repo = (folders: string[] = ['sub']) => {
  const dir = path.join(root, `r${n++}`);
  fs.mkdirSync(dir);
  g(dir, 'init', '-q', '--initial-branch=main');
  for (const [k, v] of [
    ['user.name', 't'],
    ['user.email', 't@example.invalid'],
    ['commit.gpgsign', 'false'],
  ])
    g(dir, 'config', k, v);
  fs.writeFileSync(path.join(dir, 'top.txt'), 'top\n');
  for (const f of folders) {
    fs.mkdirSync(path.join(dir, f), { recursive: true });
    fs.writeFileSync(path.join(dir, f, 'c.txt'), 'c\n');
  }
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'one');
  return dir;
};
const write: any = createHostWrite({ hostFs });

test('a path that names the folder itself, a folder or an empty step is refused; only a file name passes', () => {
  const discard = (file: unknown) => () => parseParams('host.gitDiscard', { path: '/srv/app', file });
  const commit = (path: unknown) => () => parseParams('host.gitCommit', { path: '/srv/app', message: 'm', files: [{ path }] });
  for (const bad of ['.', './', './a', 'a/.', 'sub/.', 'a/', 'a//b', '/a', 'a/./b', '..', 'a\\.', '.\\a', 'a\\']) {
    assert.throws(discard(bad), (e: any) => e instanceof Error, `discard ${bad}`);
    assert.throws(commit(bad), (e: any) => e instanceof Error, `commit ${bad}`);
  }
  assert.throws(() => parseParams('host.gitCommit', { path: '/srv/app', message: 'm', files: [{ path: 'a', oldPath: '.' }] }));
  for (const ok of ['a', 'a/b.ts', '.gitignore', 'dir/.env', 'a..b', 'a b/c']) {
    assert.doesNotThrow(discard(ok), ok);
    assert.doesNotThrow(commit(ok), ok);
  }
});

test('discard all in a folder whose name holds pattern characters touches that folder only', async () => {
  const dir = repo(['a[1]', 'a1', 'w*', 'wx']);
  for (const f of ['a[1]', 'a1', 'w*', 'wx']) {
    fs.writeFileSync(path.join(dir, f, 'c.txt'), `changed ${f}\n`);
    fs.writeFileSync(path.join(dir, f, 'new.txt'), 'new\n');
  }
  for (const f of ['a[1]', 'w*']) {
    const r = await write.discard({ path: path.join(dir, f), file: null }, 'desktop');
    assert.equal(r.ok, true, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, f, 'c.txt'), 'utf8'), 'c\n');
    assert.equal(fs.existsSync(path.join(dir, f, 'new.txt')), false);
  }
  for (const f of ['a1', 'wx']) {
    assert.equal(fs.readFileSync(path.join(dir, f, 'c.txt'), 'utf8'), `changed ${f}\n`, `${f} is a sibling`);
    assert.equal(fs.existsSync(path.join(dir, f, 'new.txt')), true);
  }
  // a folder with nothing tracked in it (only a new file) still discards that file
  fs.mkdirSync(path.join(dir, 'fresh'));
  fs.writeFileSync(path.join(dir, 'fresh', 'x.txt'), 'x\n');
  const r = await write.discard({ path: path.join(dir, 'fresh'), file: null }, 'desktop');
  assert.equal(r.ok, true, r.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'fresh', 'x.txt')), false);
});

test('a commit of everything in a folder takes that folder’s changes, not what is staged outside it', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'top.txt'), 'staged outside\n');
  g(dir, 'add', 'top.txt');
  fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'changed inside\n');
  fs.writeFileSync(path.join(dir, 'sub', 'new.txt'), 'new inside\n');
  const r = await write.commit({ path: path.join(dir, 'sub'), message: 'inside', files: null }, 'desktop');
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(g(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['sub/c.txt', 'sub/new.txt']);
  assert.equal(g(dir, 'status', '--porcelain'), 'M  top.txt', 'the staged file outside stays staged');
  // at the repository's root a commit of everything is unchanged: it takes the whole index
  const root2 = repo();
  fs.writeFileSync(path.join(root2, 'top.txt'), 'x\n');
  g(root2, 'add', 'top.txt');
  fs.writeFileSync(path.join(root2, 'sub', 'c.txt'), 'y\n');
  assert.equal((await write.commit({ path: root2, message: 'all', files: null }, 'desktop')).ok, true);
  assert.equal(g(root2, 'status', '--porcelain'), '');
});

test('a write in a folder and one at its repository’s root wait for each other; two repositories do not', async () => {
  const one = repo();
  const two = repo();
  const order: string[] = [];
  let held = false;
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const slow: any = createHostWrite({
    hostFs,
    run: async (args: string[], o: any) => {
      // the repository's own work starts at its first listing of tracked files, run from its top folder
      if (args[0] === 'ls-files') {
        const name = path.basename(o.cwd);
        order.push(`start ${name}`);
        if (o.cwd === one && !held) {
          held = true;
          await gate;
        }
        order.push(`end ${name}`);
      }
      return runGit(args, o);
    },
  });
  const inFolder = slow.discard({ path: path.join(one, 'sub'), file: null }, 'desktop');
  while (!order.includes(`start ${path.basename(one)}`)) await new Promise((r) => setTimeout(r, 10));
  const atRoot = slow.discard({ path: one, file: null }, 'desktop');
  await slow.discard({ path: two, file: null }, 'desktop');
  assert.ok(order.includes(`end ${path.basename(two)}`), 'another repository does not wait');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(order.filter((e) => e === `start ${path.basename(one)}`).length, 1, 'the root waits for the folder');
  release();
  await Promise.all([inFolder, atRoot]);
  const mine = order.filter((e) => e.endsWith(path.basename(one)));
  assert.deepEqual(mine, [
    `start ${path.basename(one)}`,
    `end ${path.basename(one)}`,
    `start ${path.basename(one)}`,
    `end ${path.basename(one)}`,
  ]);
});

test('a write is over before the app stops waiting: each run is bounded by what is left, and a write past its time is refused without running git', async () => {
  const dir = repo();
  const seen: number[] = [];
  let clock = 1_000_000;
  const timed: any = createHostWrite({
    hostFs,
    totalMs: 100_000,
    now: () => clock,
    run: async (args: string[], o: any) => {
      seen.push(o.timeout);
      clock += 30_000;
      return runGit(args, o);
    },
  });
  fs.writeFileSync(path.join(dir, 'top.txt'), 'changed\n');
  // each run takes 30 s of the clock: the write's 100 s run out before its steps do, and what is left bounds the last runs
  await assert.rejects(timed.discard({ path: dir, file: 'top.txt' }, 'desktop'), { code: 'write_timed_out' });
  assert.deepEqual(seen, [60_000, 60_000, 40_000, 10_000]);
  const calls: string[][] = [];
  const spent: any = createHostWrite({
    hostFs,
    totalMs: 0,
    run: async (args: string[]) => (calls.push(args), { ok: true, stdout: '', stderr: '' }) as any,
  });
  await assert.rejects(spent.commit({ path: dir, message: 'm', files: null }, 'desktop'), { code: 'write_timed_out' });
  assert.deepEqual(calls, [], 'no git run once the time is used up');
});
