// electron/platform/git.cjs with a real repository: a managed worktree's script and terminal variables, and its port block's lifetime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');
const pty = require('../electron/platform/pty.cjs');
const { FIRST_PORT } = require('../electron/platform/worktreePorts.cjs');

function setup(t: any) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtenv-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const repo = path.join(home, 'src', 'app');
  fs.mkdirSync(repo, { recursive: true });
  const run = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo });
  run('init', '--quiet', '--initial-branch=trunk');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  run('add', '.');
  run('commit', '--quiet', '-m', 'first');
  return { home, repo, root: path.join(home, 'trees') };
}

test('scripts and terminals in a managed worktree get its variables; other folders get none', async (t) => {
  const { home, repo, root } = setup(t);
  const one = await git.worktreeAdd(repo, { root });
  const two = await git.worktreeAdd(repo, { root });
  assert.equal(one.ok && two.ok, true);
  const id = path.basename(path.dirname(one.worktree));
  const env = git.worktreeEnv(one.worktree);
  assert.equal(env.MOPILOT_WORKSPACE_NAME, id);
  assert.equal(env.CONDUCTOR_WORKSPACE_PATH, one.worktree);
  assert.equal(env.CONDUCTOR_ROOT_PATH, repo);
  assert.equal(env.CONDUCTOR_IS_LOCAL, '1');
  // no origin here: nothing names a default branch or a starting one, so the variable is not set
  assert.equal(git.worktreeInfo(one.worktree).sourceBranch, undefined);
  assert.equal(env.CONDUCTOR_DEFAULT_BRANCH, null);
  assert.equal(env.CONDUCTOR_PORT, String(FIRST_PORT));
  assert.equal(git.worktreeEnv(two.worktree).MOPILOT_PORT, String(FIRST_PORT + 10));
  // a subfolder of the worktree is the same worktree
  fs.mkdirSync(path.join(one.worktree, 'pkg'));
  assert.equal(git.worktreeEnv(path.join(one.worktree, 'pkg')).MOPILOT_PORT, String(FIRST_PORT));
  // outside a worktree every variable is null, so one inherited from the terminal the app started in is removed
  assert.deepEqual([...new Set(Object.values(git.worktreeEnv(repo)))], [null]);
  assert.deepEqual(Object.keys(git.worktreeEnv('relative')).sort(), Object.keys(env).sort());
  // the same worktree through another spelling of its path is the same block
  fs.symlinkSync(root, path.join(home, 'link'));
  assert.equal(git.worktreeEnv(path.join(home, 'link', id, 'app')).MOPILOT_PORT, String(FIRST_PORT));
  // the pty layer asks git.cjs, so a terminal tab and a setup script see the same values
  const spec = pty.spawnSpec({ cwd: one.worktree }, { env: { PATH: '/usr/bin' }, shell: '/bin/zsh', home });
  assert.equal(spec.env.CONDUCTOR_PORT, String(FIRST_PORT));
  assert.equal(spec.env.MOPILOT_ROOT_PATH, repo);
  const outside = pty.spawnSpec({ cwd: repo }, { env: { MOPILOT_PORT: '55100', CONDUCTOR_ROOT_PATH: '/other' }, shell: '/bin/zsh', home });
  assert.equal('MOPILOT_PORT' in outside.env, false);
  assert.equal('CONDUCTOR_ROOT_PATH' in outside.env, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.mopilot', 'worktree-ports.json'), 'utf8')), {
    [git.canonical(one.worktree)]: FIRST_PORT,
    [git.canonical(two.worktree)]: FIRST_PORT + 10,
  });
});

test('a removed worktree gives up its block; one that could not be removed keeps it', async (t) => {
  const { home, repo, root } = setup(t);
  const one = await git.worktreeAdd(repo, { root });
  const two = await git.worktreeAdd(repo, { root });
  git.worktreeEnv(one.worktree);
  git.worktreeEnv(two.worktree);
  const table = () => JSON.parse(fs.readFileSync(path.join(home, '.mopilot', 'worktree-ports.json'), 'utf8'));
  // git refuses a repository that is not one, and the folder is still there
  assert.equal(await git.removeWorktree({ path: two.worktree, repo: path.join(home, 'nowhere') }), false);
  assert.equal(table()[git.canonical(two.worktree)], FIRST_PORT + 10);
  assert.equal(await git.removeWorktree({ path: one.worktree, repo }), true);
  assert.deepEqual(table(), { [git.canonical(two.worktree)]: FIRST_PORT + 10 });
  const three = await git.worktreeAdd(repo, { root });
  assert.equal(git.worktreeEnv(three.worktree).MOPILOT_PORT, String(FIRST_PORT));
});

test("origin's default branch wins over the branch the worktree started from, also after a restore", async (t) => {
  const { home, repo, root } = setup(t);
  const origin = path.join(home, 'origin.git');
  execFileSync('git', ['clone', '--quiet', '--bare', repo, origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repo });
  execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: repo });
  execFileSync('git', ['remote', 'set-head', 'origin', 'trunk'], { cwd: repo });
  execFileSync('git', ['switch', '--quiet', '-c', 'feature'], { cwd: repo });
  const made = await git.worktreeAdd(repo, { root, branch: 'feature' });
  assert.equal(made.ok, true, made.error);
  assert.equal(git.worktreeInfo(made.worktree).sourceBranch, 'feature');
  assert.equal(git.worktreeEnv(made.worktree).CONDUCTOR_DEFAULT_BRANCH, 'trunk');
  assert.equal(await git.removeWorktree({ path: made.worktree, repo }), true);
  const back = await git.worktreeRestore(made.worktree, root, repo);
  assert.equal(back.restored, true, back.error);
  assert.equal(git.worktreeEnv(made.worktree).MOPILOT_DEFAULT_BRANCH, 'trunk');
});
