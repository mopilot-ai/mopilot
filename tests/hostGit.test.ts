// Clone and worktree on the Host (host/src/hostGit.mjs, package 2.7) with a fake git: progress, no half directory, repeats are idempotent.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { HostRefusal, createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostGit, folderOf, progressOf, runGit } from '../host/src/hostGit.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(path.join(root, 'repo'), { recursive: true });
const hostFs = createHostFs({ roots: [root] });
const URL = 'https://github.com/a/b.git';
const refusal = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: any) => e instanceof HostRefusal && e.code === code);

type Call = { args: string[]; cwd?: string };
/** A git whose `clone` and `worktree add` make the folder they are given, and whose other commands answer from `answers`. */
function fakeGit(
  o: { cloneFails?: string; answers?: Record<string, { ok: boolean; stdout?: string; stderr?: string }>; gate?: Promise<void> } = {},
) {
  const calls: Call[] = [];
  const run = async (args: string[], opts: { cwd?: string; onLine?: (l: string) => void } = {}) => {
    calls.push({ args, cwd: opts.cwd });
    const verb = args[0];
    if (verb === 'clone') {
      opts.onLine?.('Cloning into x...');
      opts.onLine?.('Receiving objects:  45% (9/20)');
      await o.gate;
      const dir = args[args.length - 1];
      fs.mkdirSync(dir, { recursive: true });
      if (o.cloneFails !== undefined) return { ok: false, stdout: '', stderr: o.cloneFails ? `partial\n${o.cloneFails}\n` : '' };
      return { ok: true, stdout: '', stderr: '' };
    }
    if (verb === 'worktree') {
      if (o.answers?.worktree && !o.answers.worktree.ok) return { stdout: '', stderr: '', ...o.answers.worktree };
      fs.mkdirSync(args[args.indexOf('add') + (args.includes('-b') ? 3 : 1)], { recursive: true });
      return { ok: true, stdout: '', stderr: '' };
    }
    const a = o.answers?.[verb] ?? { ok: true };
    return { stdout: '', stderr: '', ...a };
  };
  return { run, calls };
}

test('progressOf reads git progress lines', () => {
  assert.deepEqual(progressOf('Receiving objects:  45% (9/20)'), { phase: 'Receiving objects', percent: 45 });
  assert.deepEqual(progressOf('remote: Compressing objects: 100% (3/3)'), { phase: 'Compressing objects', percent: 100 });
  assert.equal(progressOf('Cloning into x...'), null);
});

test('B1/I1: a branch maps to one folder name, and two branches never share one', () => {
  assert.equal(folderOf('feat/x'), 'feat%2fx');
  assert.notEqual(folderOf('a/b'), folderOf('a%2fb'));
  assert.equal(folderOf('v1.0-rc_1'), 'v1.0-rc_1');
});

test('clone streams progress, lands whole in the final place, leaves no partial folder', async () => {
  const f = fakeGit();
  const seen: unknown[] = [];
  const g = createHostGit({ hostFs, run: f.run, onProgress: (k: string, p: unknown) => seen.push([k, p]) });
  const r = await g.clone({ key: 'key-clone-1', url: URL, dest: path.join(root, 'b') });
  assert.deepEqual(r, { path: path.join(root, 'b'), existed: false });
  assert.deepEqual(seen, [['key-clone-1', { phase: 'Receiving objects', percent: 45 }]]);
  assert.deepEqual(fs.readdirSync(root).sort(), ['b', 'repo']);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['clone', '--progress', '--']);
});

test('W3: a failed clone removes the partial folder and reports git’s last line', async () => {
  const g = createHostGit({ hostFs, run: fakeGit({ cloneFails: 'fatal: repository not found' }).run });
  await assert.rejects(
    g.clone({ key: 'key-fail-001', url: URL, dest: path.join(root, 'c') }),
    (e: any) => e.code === 'clone_failed' && /not found/.test(e.message),
  );
  assert.ok(!fs.readdirSync(root).some((n) => n.includes('clone') || n === 'c'));
  const silent = createHostGit({ hostFs, run: fakeGit({ cloneFails: '' }).run });
  await refusal(silent.clone({ key: 'key-fail-002', url: URL, dest: path.join(root, 'c') }), 'clone_failed');
});

test('A1: the same key twice shares one clone, in flight and after; a refusal is shared too', async () => {
  let open!: () => void;
  const f = fakeGit({ gate: new Promise<void>((r) => (open = r)) });
  const g = createHostGit({ hostFs, run: f.run });
  const a = g.clone({ key: 'key-same-001', url: URL, dest: path.join(root, 'd') });
  const b = g.clone({ key: 'key-same-001', url: URL, dest: path.join(root, 'd') });
  open();
  assert.deepEqual(await a, await b);
  assert.equal(f.calls.filter((c) => c.args[0] === 'clone').length, 1);
  assert.equal((await g.clone({ key: 'key-same-001', url: URL, dest: path.join(root, 'd') })).existed, false);
});

test('a new key for a folder that already holds this repository is a no-op; another repository there is refused', async () => {
  const done = path.join(root, 'd');
  const same = createHostGit({ hostFs, run: fakeGit({ answers: { remote: { ok: true, stdout: `${URL}\n` } } }).run });
  assert.deepEqual(await same.clone({ key: 'key-again-01', url: URL, dest: done }), { path: done, existed: true });
  const other = createHostGit({ hostFs, run: fakeGit({ answers: { remote: { ok: true, stdout: 'https://x/y.git\n' } } }).run });
  await refusal(other.clone({ key: 'key-again-02', url: URL, dest: done }), 'invalid_path');
  const notRepo = createHostGit({ hostFs, run: fakeGit({ answers: { remote: { ok: false } } }).run });
  await refusal(notRepo.clone({ key: 'key-again-03', url: URL, dest: done }), 'invalid_path');
});

test('E: dest outside the roots, missing parent, or a path trick is refused before git runs', async () => {
  const f = fakeGit();
  const g = createHostGit({ hostFs, run: f.run });
  await refusal(g.clone({ key: 'key-esc-0001', url: URL, dest: path.join(base, 'out') }), 'outside_roots');
  await refusal(g.clone({ key: 'key-esc-0002', url: URL, dest: path.join(root, 'nope', 'x') }), 'directory_missing');
  await refusal(g.clone({ key: 'key-esc-0003', url: URL, dest: root + path.sep }), 'outside_roots');
  await refusal(g.clone({ key: 'key-esc-0004', url: URL, dest: `${root}/..` }), 'invalid_path');
  await refusal(g.clone({ key: 'key-esc-0005', url: URL, dest: 5 as any }), 'invalid_path');
  await refusal(g.clone({ key: 'key-esc-0006', url: URL, dest: '/' }), 'invalid_path');
  assert.equal(f.calls.length, 0);
});

test('worktree: makes a new branch beside the repo, uses an existing one, repeats are idempotent', async () => {
  const repo = path.join(root, 'repo');
  const f = fakeGit({ answers: { 'rev-parse': { ok: false } } });
  const g = createHostGit({ hostFs, run: f.run });
  const r = await g.worktree({ key: 'key-wt-0001', repo, branch: 'feat/x' });
  assert.deepEqual(r, { path: path.join(root, 'repo.worktrees', 'feat%2fx'), existed: false });
  assert.ok(f.calls.some((c) => c.args.includes('-b')));
  assert.equal((await g.worktree({ key: 'key-wt-0001', repo, branch: 'feat/x' })).existed, false);
  const known = fakeGit({ answers: { 'rev-parse': { ok: true, stdout: 'main\n' } } });
  const g2 = createHostGit({ hostFs, run: known.run });
  assert.equal((await g2.worktree({ key: 'key-wt-0002', repo, branch: 'main' })).existed, false);
  assert.ok(!known.calls.some((c) => c.args.includes('-b')));
  const there = fakeGit({ answers: { 'rev-parse': { ok: true, stdout: 'feat/x\n' } } });
  assert.equal((await createHostGit({ hostFs, run: there.run }).worktree({ key: 'key-wt-0003', repo, branch: 'feat/x' })).existed, true);
  const wrong = fakeGit({ answers: { 'rev-parse': { ok: true, stdout: 'other\n' } } });
  await refusal(createHostGit({ hostFs, run: wrong.run }).worktree({ key: 'key-wt-0004', repo, branch: 'feat/x' }), 'invalid_path');
});

test('worktree refusals: bad branch, git failure, repo outside roots, repo at the root itself', async () => {
  const repo = path.join(root, 'repo');
  await refusal(
    createHostGit({ hostFs, run: fakeGit({ answers: { 'check-ref-format': { ok: false } } }).run }).worktree({
      key: 'key-wt-1001',
      repo,
      branch: 'a..b',
    }),
    'invalid_path',
  );
  fs.rmSync(path.join(root, 'repo.worktrees'), { recursive: true, force: true });
  const failing = fakeGit({ answers: { worktree: { ok: false, stderr: 'fatal: boom\n' } } });
  await assert.rejects(
    createHostGit({ hostFs, run: failing.run }).worktree({ key: 'key-wt-1002', repo, branch: 'zz' }),
    (e: any) => e.code === 'worktree_failed' && /boom/.test(e.message),
  );
  const mute = fakeGit({ answers: { worktree: { ok: false } } });
  await refusal(createHostGit({ hostFs, run: mute.run }).worktree({ key: 'key-wt-1003', repo, branch: 'zz' }), 'worktree_failed');
  const g = createHostGit({ hostFs, run: fakeGit().run });
  await refusal(g.worktree({ key: 'key-wt-1004', repo: outsideDir(), branch: 'x' }), 'outside_roots');
  await refusal(g.worktree({ key: 'key-wt-1005', repo: root, branch: 'x' }), 'outside_roots');
});
function outsideDir() {
  return base;
}

test('runGit runs the real git: output, progress lines, failure and a missing binary', async () => {
  const lines: string[] = [];
  const v = await runGit(['--version'], { onLine: (l: string) => lines.push(l) });
  assert.ok(v.ok && /git version/.test(v.stdout));
  const bad = await runGit(['definitely-not-a-command'], { cwd: base, onLine: (l: string) => lines.push(l) });
  assert.equal(bad.ok, false);
  assert.ok(lines.length > 0);
  assert.equal((await runGit(['--version'])).ok, true);
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const none = await runGit(['--version']);
    assert.equal(none.ok, false);
    assert.ok(none.stderr);
  } finally {
    process.env.PATH = saved;
  }
});

test('W3: a rename that loses a race removes the partial folder; a throwing progress listener does not stop the clone', async () => {
  const f = fakeGit();
  const racing = async (args: string[], o: any) => {
    const r = await f.run(args, o);
    if (args[0] === 'clone') {
      fs.mkdirSync(path.join(root, 'race', 'x'), { recursive: true });
    }
    return r;
  };
  const g = createHostGit({
    hostFs,
    run: racing as any,
    onProgress: () => {
      throw new Error('listener');
    },
  });
  await refusal(g.clone({ key: 'key-race-001', url: URL, dest: path.join(root, 'race') }), 'clone_failed');
  assert.ok(!fs.readdirSync(root).some((n) => n.includes('.clone-')));
});
