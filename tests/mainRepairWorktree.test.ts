// Uses real Git to distinguish fetched main from local-ahead work and verifies trusted setup selection for repair worktrees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { worktreeAdd } = require('../electron/platform/git.cjs');
const { pinnedMain } = require('../electron/platform/worktreeSource.cjs');
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
test('a repair worktree starts at fetched main while local-ahead commits and uncommitted edits stay in place', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-worktree-'))),
    repo = path.join(root, 'repo');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(repo, 'file'), 'main');
  git('add', '.');
  git('commit', '-m', 'main');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  fs.writeFileSync(path.join(repo, 'file'), 'local-ahead');
  git('commit', '-am', 'local feature');
  const ahead = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'uncommitted'), 'preserve');
  const made = await worktreeAdd(repo, { root: path.join(root, 'worktrees'), baseCommit: base });
  // unattended and set up from the pinned commit alone: none of the local checkout's ignored files are copied in
  assert.equal('copy' in made, false);
  assert.equal(made.ok, true);
  assert.equal(fs.readFileSync(path.join(made.path, 'file'), 'utf8'), 'main');
  assert.equal(git('rev-parse', 'HEAD'), ahead);
  assert.equal(fs.readFileSync(path.join(repo, 'uncommitted'), 'utf8'), 'preserve');
  assert.equal((await worktreeAdd(repo, { root: path.join(root, 'other'), baseCommit: ahead })).ok, false);
  assert.equal((await worktreeAdd(repo, { root: path.join(root, 'other'), baseCommit: 'main' })).ok, false);
  assert.equal((await pinnedMain(repo, 'f'.repeat(40), { hasCommit: async () => false, git: async () => ({ ok: true }) })).ok, false);
});
test('pinned setup runs only the script from the fetched worktree and passes the immutable base to the native starter', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-setup-')),
    repo = path.join(root, 'repo'),
    wt = path.join(root, 'wt'),
    scripts: any[] = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [dir, script] of [
    [repo, 'feature-script'],
    [wt, 'main-script'],
  ]) {
    fs.mkdirSync(path.join(dir, '.codex/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex/environments/environment.toml'), `[setup]\nscript="${script}"\n`);
  }
  const starter = new ChatStarter({
    prefs: () => ({}),
    worktree: async (_cwd: string, opts: any) => {
      assert.equal(opts.baseCommit, 'a'.repeat(40));
      return { ok: true, repo, worktree: wt, path: wt };
    },
    script: async (...args: any[]) => {
      scripts.push(args);
      return { exitCode: 0 };
    },
  });
  assert.deepEqual(await starter.newWorktree(repo, { baseCommit: 'a'.repeat(40) }), { path: wt });
  assert.deepEqual(scripts, [[wt, 'main-script']]);
  starter.o.worktree = async (_cwd: string, opts: any) => {
    assert.equal('baseCommit' in opts, false);
    return { ok: true, repo, worktree: wt, path: wt };
  };
  assert.deepEqual(await starter.newWorktree(repo), { path: wt });
  assert.deepEqual(scripts.at(-1), [wt, 'feature-script']);
  starter.o.worktree = async (_cwd: string, opts: any) => {
    assert.equal(opts.startPoint, 'head');
    assert.equal('baseCommit' in opts, false);
    return { ok: true, repo, worktree: wt, path: wt };
  };
  assert.deepEqual(await starter.newWorktree(repo, { startPoint: 'head' }), { path: wt });
});
