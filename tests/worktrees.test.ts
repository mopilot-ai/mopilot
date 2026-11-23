// electron/platform/git.cjs: managed worktrees, auto-delete and environment scripts, on a temp repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPrefs } from '../src/store/types.ts';

const require = createRequire(import.meta.url);
const wt = require('../electron/platform/git.cjs');

function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-wt-')));
  const repo = path.join(dir, 'demo');
  fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'pkg', 'a.txt'), 'a\n');
  run('add', '.');
  run('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  return { dir, repo, root: path.join(dir, 'worktrees') };
}

test('a worktree goes under the root on a mopilot/ branch, keeps the subfolder, and is known as managed', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const r = await wt.worktreeAdd(path.join(repo, 'pkg'), { root });
    assert.equal(r.ok, true);
    assert.match(r.branch, /^mopilot\/[0-9a-f]{4}$/);
    assert.equal(path.dirname(path.dirname(r.worktree)), root);
    assert.equal(path.basename(r.worktree), 'demo');
    assert.equal(r.path, path.join(r.worktree, 'pkg'));
    assert.equal(r.repo, repo);
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: r.worktree, encoding: 'utf8' }).trim(), r.branch);
    assert.deepEqual(wt.worktreeInfo(r.path), { path: r.worktree, repo, branch: r.branch, createdAt: wt.listWorktrees(root)[0].createdAt });
    assert.equal(wt.worktreeInfo(repo), null);
    assert.equal((await wt.worktreeAdd(dir, { root })).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a project opened through a symlink keeps its subfolder in the worktree', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    // the same repository by another spelling, as /tmp is /private/tmp on macOS
    const link = path.join(dir, 'link');
    fs.symlinkSync(repo, link);
    const r = await wt.worktreeAdd(path.join(link, 'pkg'), { root });
    assert.equal(r.ok, true);
    assert.equal(r.path, path.join(r.worktree, 'pkg'));
    assert.ok(fs.existsSync(r.path));
    // at the top it is the worktree itself
    const top = await wt.worktreeAdd(link, { root });
    assert.equal(top.path, top.worktree);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worktree starts from origin's freshly fetched default branch, not the checked-out branch, and tracks nothing", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-wt-')));
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
  try {
    const upstream = path.join(dir, 'upstream');
    fs.mkdirSync(upstream);
    sh(upstream, 'init', '-q', '-b', 'main');
    sh(upstream, 'commit', '-q', '--allow-empty', '-m', 'one');
    const repo = path.join(dir, 'demo');
    sh(dir, 'clone', '-q', upstream, repo);
    // the checkout sits on a feature branch, and main moves on upstream after the clone
    sh(repo, 'checkout', '-q', '-b', 'feature');
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'feature work');
    sh(upstream, 'commit', '-q', '--allow-empty', '-m', 'two');
    const r = await wt.worktreeAdd(repo, { root: path.join(dir, 'worktrees') });
    assert.equal(r.ok, true);
    assert.equal(sh(r.worktree, 'rev-parse', 'HEAD'), sh(upstream, 'rev-parse', 'main'));
    assert.equal(sh(r.worktree, 'log', '-1', '--format=%s'), 'two');
    assert.throws(() => sh(r.worktree, 'rev-parse', '--abbrev-ref', '@{u}'));
    assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a picked branch is the worktree base, ahead-of-origin local commits included; the list and switching work on a real repo', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-wt-')));
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
  try {
    const upstream = path.join(dir, 'upstream');
    fs.mkdirSync(upstream);
    sh(upstream, 'init', '-q', '-b', 'main');
    sh(upstream, 'commit', '-q', '--allow-empty', '-m', 'one');
    sh(upstream, 'branch', 'release');
    const repo = path.join(dir, 'demo');
    sh(dir, 'clone', '-q', upstream, repo);
    sh(repo, 'checkout', '-q', '-b', 'feature');
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'local only');
    // release moves on upstream; the clone never checked it out locally
    sh(upstream, 'checkout', '-q', 'release');
    sh(upstream, 'commit', '-q', '--allow-empty', '-m', 'release fix');
    const root = path.join(dir, 'worktrees');
    const fromRelease = await wt.worktreeAdd(repo, { root, branch: 'release' });
    assert.equal(sh(fromRelease.worktree, 'log', '-1', '--format=%s'), 'release fix');
    const fromFeature = await wt.worktreeAdd(repo, { root, branch: 'feature' });
    assert.equal(sh(fromFeature.worktree, 'log', '-1', '--format=%s'), 'local only');
    assert.deepEqual(await wt.worktreeAdd(repo, { root, branch: 'nope' }), { ok: false, error: 'Branch nope not found' });

    const list = await wt.listBranches(repo);
    assert.equal(list.current, 'feature');
    assert.equal(list.default, 'main');
    assert.equal(list.branches[0], 'main');
    assert.ok(list.branches.includes('feature'));
    assert.deepEqual(await wt.switchBranch(repo, 'main'), { ok: true });
    assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'x');
    sh(repo, 'add', 'f.txt');
    sh(repo, 'commit', '-q', '-m', 'f');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'dirty');
    const refused = await wt.switchBranch(repo, 'feature');
    assert.equal(refused.ok, false);
    assert.match(refused.error, /^Can.t switch to "feature": there are uncommitted changes on "main"/);
    assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'dirty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-delete keeps the newest, and never a worktree in use or with changes', () => {
  const list = [1, 2, 3, 4, 5].map((n) => ({ path: `/wt/${n}/demo`, repo: '/demo', branch: `b${n}`, createdAt: n }));
  const names = (xs: { path: string }[]) => xs.map((x) => x.path);
  assert.deepEqual(names(wt.pruneCandidates(list, 2, [], () => false)), ['/wt/3/demo', '/wt/2/demo', '/wt/1/demo']);
  assert.deepEqual(names(wt.pruneCandidates(list, 2, ['/wt/2/demo/pkg'], (w: any) => w.path === '/wt/1/demo')), ['/wt/3/demo']);
  assert.deepEqual(names(wt.pruneCandidates(list, 15, [], () => false)), []);
});

test('pruning removes old managed worktrees only, and leaves their branches', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const made: Awaited<ReturnType<typeof wt.worktreeAdd>>[] = [];
    for (let i = 0; i < 3; i++) {
      made.push(await wt.worktreeAdd(repo, { root }));
      await new Promise((r) => setTimeout(r, 5));
    }
    // a worktree another app made under the same root is never touched
    const foreign = path.join(root, 'zzzz', 'demo');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'other', foreign], { cwd: repo, stdio: 'ignore' });
    const removed = await wt.pruneWorktrees(root, 1, []);
    assert.deepEqual(removed.sort(), [made[0].worktree, made[1].worktree].sort());
    assert.equal(fs.existsSync(path.dirname(made[0].worktree)), false);
    assert.equal(fs.existsSync(made[2].worktree), true);
    assert.equal(fs.existsSync(foreign), true);
    const branches = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: repo, encoding: 'utf8' });
    assert.ok(branches.includes(made[0].branch));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pruned worktree comes back from its kept branch, once, and only when it is one of ours', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const made = await wt.worktreeAdd(path.join(repo, 'pkg'), { root });
    assert.deepEqual(await wt.worktreeRestore(made.path, root, repo), { ok: true, restored: false });
    await wt.removeWorktree({ path: made.worktree, repo });
    assert.equal(fs.existsSync(made.path), false);
    const r = await wt.worktreeRestore(made.path, root, repo);
    assert.equal(r.ok, true);
    assert.equal(r.restored, true);
    assert.equal(r.branch, made.branch);
    assert.equal(r.worktree, made.worktree);
    assert.equal(fs.existsSync(path.join(made.path, 'a.txt')), true);
    assert.equal(wt.worktreeInfo(made.path)?.branch, made.branch);
    // not under the root, no project, or no kept branch: nothing is made up
    assert.equal((await wt.worktreeRestore(path.join(dir, 'elsewhere', 'demo'), root, repo)).error, 'Not a MoPilot worktree');
    await wt.removeWorktree({ path: made.worktree, repo });
    assert.match((await wt.worktreeRestore(made.path, root, path.join(dir, 'gone'))).error, /project folder is gone/);
    execFileSync('git', ['branch', '-D', made.branch], { cwd: repo, stdio: 'ignore' });
    assert.match((await wt.worktreeRestore(made.path, root, repo)).error, /branch for this worktree/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree made with a branch prefix without a slash is restored on its own branch', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const made = await wt.worktreeAdd(path.join(repo, 'pkg'), { root, prefix: 'bwang-' });
    assert.match(made.branch, /^bwang-[0-9a-f]{4}$/);
    await wt.removeWorktree({ path: made.worktree, repo });
    const r = await wt.worktreeRestore(made.path, root, repo, 'bwang-');
    assert.deepEqual([r.ok, r.restored, r.branch], [true, true, made.branch]);
    assert.equal(fs.existsSync(path.join(made.path, 'a.txt')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upgrading the default prefix names new worktrees mopilot/ and restores existing codex/ branches unchanged', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const old = await wt.worktreeAdd(repo, { root, prefix: 'codex/' });
    assert.equal(old.ok, true);
    const prefs = loadPrefs({ prefsVersion: 3, branchPrefix: 'codex/' });
    const next = await wt.worktreeAdd(repo, { root, prefix: prefs.branchPrefix });
    assert.equal(next.ok, true);
    assert.match(next.branch, /^mopilot\/[0-9a-f]{4}$/);
    await wt.removeWorktree({ path: old.worktree, repo });
    const restored = await wt.worktreeRestore(old.path, root, repo, prefs.branchPrefix);
    assert.equal(restored.ok, true);
    assert.equal(restored.branch, old.branch);
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: restored.worktree, encoding: 'utf8' }).trim(), old.branch);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restoration honors a recorded legacy branch and refuses an ambiguous id after its marker is removed', async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const old = await wt.worktreeAdd(repo, { root, prefix: 'codex/' });
    const id = path.basename(path.dirname(old.worktree));
    execFileSync('git', ['branch', `mopilot/${id}`], { cwd: repo });
    fs.rmSync(old.worktree, { recursive: true, force: true });
    const restored = await wt.worktreeRestore(old.path, root, repo, 'mopilot/');
    assert.equal(restored.branch, old.branch);
    await wt.removeWorktree({ path: old.worktree, repo });
    const ambiguous = await wt.worktreeRestore(old.path, root, repo, 'mopilot/');
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.error, /Multiple branches/);
    assert.equal(fs.existsSync(old.path), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a script runs in the login shell in the given folder and reports its exit code', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-script-')));
  try {
    const ok = await wt.runScript(dir, 'echo ran > marker.txt && pwd');
    assert.equal(ok.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8').trim(), 'ran');
    assert.match(ok.output, new RegExp(path.basename(dir)));
    const bad = await wt.runScript(dir, 'echo nope; exit 3');
    assert.equal(bad.exitCode, 3);
    assert.match(bad.output, /nope/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worktree deleted under its holder is restored for a chat that doesn't record its project, from the holder's marker", async () => {
  const { dir, repo, root } = tempRepo();
  try {
    const made = await wt.worktreeAdd(path.join(repo, 'pkg'), { root });
    // another app's cleanup removed the checkout but left the holder and its marker
    fs.rmSync(made.worktree, { recursive: true, force: true });
    for (const known of [null, path.join(dir, 'moved')]) {
      const r = await wt.worktreeRestore(made.path, root, known);
      assert.deepEqual([r.ok, r.restored, r.branch, r.repo], [true, true, made.branch, repo]);
      assert.equal(fs.existsSync(path.join(made.path, 'a.txt')), true);
      fs.rmSync(made.worktree, { recursive: true, force: true });
    }
    // a marker that names no project still says the project is gone
    fs.writeFileSync(path.join(path.dirname(made.worktree), '.mopilot-worktree.json'), '{}');
    assert.match((await wt.worktreeRestore(made.path, root, null)).error, /project folder is gone/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
