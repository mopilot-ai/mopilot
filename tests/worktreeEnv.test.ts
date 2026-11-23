// electron/platform/worktreeEnv.cjs: the MOPILOT_* and CONDUCTOR_* variables of a managed worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { envFor, originDefaultBranch, PORTS_PER_WORKTREE } = require('../electron/platform/worktreeEnv.cjs');

test('a worktree gets its name, paths, default branch and port under both prefixes', () => {
  const env = envFor({ path: '/w/ab12/app', repo: '/src/app', sourceBranch: 'feature', defaultBranch: 'trunk' }, 42010);
  const want = {
    WORKSPACE_NAME: 'ab12',
    WORKSPACE_ID: 'ab12',
    WORKSPACE_PATH: '/w/ab12/app',
    ROOT_PATH: '/src/app',
    DEFAULT_BRANCH: 'trunk',
    PORT: '42010',
    IS_LOCAL: '1',
  };
  const both: Record<string, string> = {};
  for (const [k, v] of Object.entries(want)) both[`MOPILOT_${k}`] = both[`CONDUCTOR_${k}`] = v;
  assert.deepEqual(env, both);
  assert.equal(PORTS_PER_WORKTREE, 10);
});

test('a repository without a default branch on origin falls back to the branch the worktree started from', () => {
  assert.equal(envFor({ path: '/w/ab12/app', repo: '/src/app', sourceBranch: 'main' }, 42000).MOPILOT_DEFAULT_BRANCH, 'main');
});

test('what is not known is null, to be removed: no port block, no branch; every variable outside a worktree', () => {
  const env = envFor({ path: '/w/ab12/app', repo: '/src/app', sourceBranch: '' });
  assert.equal(env.MOPILOT_PORT, null);
  assert.equal(env.CONDUCTOR_PORT, null);
  assert.equal(env.MOPILOT_DEFAULT_BRANCH, null);
  assert.equal(env.CONDUCTOR_ROOT_PATH, '/src/app');
  const outside = envFor(null, 42000);
  assert.equal(Object.keys(outside).length, 14);
  assert.deepEqual([...new Set(Object.values(outside))], [null]);
  assert.deepEqual(Object.keys(outside).sort(), Object.keys(env).sort());
});

test("origin's default branch is read from the repository's files, also through a linked worktree's .git file", (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtenv-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const repo = path.join(d, 'app');
  fs.mkdirSync(path.join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  assert.equal(originDefaultBranch(repo), '', 'origin has no default set');
  fs.writeFileSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/release/2\n');
  assert.equal(originDefaultBranch(repo), 'release/2');
  // a linked worktree: .git names its own git folder, whose commondir names the repository's
  const linked = path.join(d, 'linked');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'linked'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'linked', 'commondir'), '../..\n');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'linked')}\n`);
  assert.equal(originDefaultBranch(linked), 'release/2');
  // a submodule or a separate git folder: .git names the repository's own git folder, which has no commondir
  const separate = path.join(d, 'separate');
  fs.mkdirSync(separate);
  fs.writeFileSync(path.join(separate, '.git'), 'gitdir: ../app/.git\n');
  assert.equal(originDefaultBranch(separate), 'release/2');
  fs.writeFileSync(path.join(linked, '.git'), 'not a pointer\n');
  assert.equal(originDefaultBranch(linked), '');
  fs.writeFileSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'HEAD'), '0123abcd\n');
  assert.equal(originDefaultBranch(repo), '', 'a detached origin/HEAD names no branch');
  assert.equal(originDefaultBranch(path.join(d, 'none')), '');
});
