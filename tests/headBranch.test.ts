// A project's current branch for the phone's project chip: read from HEAD (a worktree's .git file followed), null when unknown, and the path never sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { headBranch, phoneProjects } = require('../electron/platform/headBranch.cjs');
const projects = require('../electron/platform/projects.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'head-branch-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
/** A folder with the given files, relative paths to contents. */
function folder(name: string, files: Record<string, string>) {
  const dir = path.join(root, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('a checkout on a branch names it, slashes and all', () => {
  assert.equal(headBranch(folder('repo', { '.git/HEAD': 'ref: refs/heads/main\n' })), 'main');
  assert.equal(headBranch(folder('nested', { '.git/HEAD': 'ref: refs/heads/mobile/ios-baseline\n' })), 'mobile/ios-baseline');
});

test("a linked worktree's .git file is followed, relative or absolute", () => {
  const real = folder('real-gitdir', { 'worktrees/wt/HEAD': 'ref: refs/heads/fix/login\n' });
  assert.equal(headBranch(folder('wt-abs', { '.git': `gitdir: ${path.join(real, 'worktrees/wt')}\n` })), 'fix/login');
  assert.equal(headBranch(folder('wt-rel', { '.git': 'gitdir: ../real-gitdir/worktrees/wt\n' })), 'fix/login');
});

test('no branch is reported for a detached HEAD, a plain folder, a missing folder, a broken pointer or a path that is not absolute', () => {
  assert.equal(headBranch(folder('detached', { '.git/HEAD': '3f2a9c0d1e\n' })), null);
  assert.equal(headBranch(folder('other-ref', { '.git/HEAD': 'ref: refs/remotes/origin/main\n' })), null);
  assert.equal(headBranch(folder('plain', { 'README.md': 'hi' })), null);
  assert.equal(headBranch(path.join(root, 'gone')), null);
  assert.equal(headBranch(folder('dangling', { '.git': 'gitdir: /nowhere/at/all\n' })), null);
  assert.equal(headBranch(folder('junk-pointer', { '.git': 'not a pointer' })), null);
  assert.equal(headBranch('relative/dir'), null);
  assert.equal(headBranch(undefined), null);
});

test("the phone's project rows carry id, name and branch, never the folder's path; projects.cjs hands out the same function", () => {
  const repo = folder('listed', { '.git/HEAD': 'ref: refs/heads/dev\n' });
  const rows = phoneProjects([
    { id: 'p1', name: 'Listed', path: repo, source: 'sage' },
    { id: 'p2', name: 'Plain', path: folder('listed-plain', {}) },
  ]);
  assert.deepEqual(rows, [
    { id: 'p1', name: 'Listed', branch: 'dev' },
    { id: 'p2', name: 'Plain', branch: null },
  ]);
  assert.equal(projects.phoneProjects, phoneProjects);
});
