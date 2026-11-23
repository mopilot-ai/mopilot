// A worktree on a branch named for its task (electron/platform/worktreeSource.cjs namedBranch, through git.cjs worktreeAdd), with real git: made from the base tracking nothing, an existing one used as it is, one checked out elsewhere refused, and its worktree restored on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

function setup(t: any) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtnamed-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', [...ID, ...args], { cwd, stdio: 'pipe' })
      .toString()
      .trim();
  const origin = path.join(home, 'origin.git');
  const seed = path.join(home, 'seed');
  fs.mkdirSync(seed);
  sh(home, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  sh(seed, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '--quiet', '-m', 'first');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '--quiet', 'origin', 'main');
  const repo = path.join(home, 'app');
  sh(home, 'clone', '--quiet', origin, repo);
  return { repo, root: path.join(home, 'worktrees'), sh };
}

test('a new branch named for the task is made from the base, tracks nothing, records the base, and is restored on', async (t) => {
  const s = setup(t);
  const wt = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'pat/eng-12-fix-login' });
  assert.equal(wt.ok, true, wt.error);
  assert.equal(wt.branch, 'pat/eng-12-fix-login');
  assert.equal(s.sh(wt.worktree, 'rev-parse', 'HEAD'), s.sh(s.repo, 'rev-parse', 'origin/main'));
  assert.throws(() => s.sh(wt.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'));
  assert.equal(git.worktreeInfo(wt.worktree).sourceBranch, 'main');
  await git.removeWorktree({ path: wt.worktree, repo: s.repo });
  const back = await git.worktreeRestore(wt.path, s.root, s.repo);
  assert.equal(back.ok, true, back.error);
  assert.equal(back.branch, 'pat/eng-12-fix-login');
});

test('a branch of the user’s own, the base, or origin’s default get the usual name; one MoPilot made is worked on as it is', async (t) => {
  const s = setup(t);
  // the user's own branch of that name (no worktree of MoPilot's was made on it): not taken over
  s.sh(s.repo, 'branch', 'eng-12', 'origin/main');
  const theirs = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'eng-12' });
  assert.equal(theirs.ok, true, theirs.error);
  assert.notEqual(theirs.branch, 'eng-12');
  // Linear suggesting the base or the default branch: never worked on directly
  for (const name of ['main']) {
    const wt = await git.worktreeAdd(s.repo, { root: s.root, newBranch: name });
    assert.equal(wt.ok, true, wt.error);
    assert.notEqual(wt.branch, name);
  }
  // one MoPilot made for the issue before, with work on it: worked on again as it is
  const first = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'eng-13' });
  fs.writeFileSync(path.join(first.worktree, 'b.txt'), 'b');
  s.sh(first.worktree, 'add', '.');
  s.sh(first.worktree, 'commit', '--quiet', '-m', 'mine');
  const mine = s.sh(first.worktree, 'rev-parse', 'HEAD');
  assert.deepEqual(await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'eng-13' }), {
    ok: false,
    error: `eng-13 is already checked out in ${first.worktree}. Work there, or remove that worktree first.`,
  });
  await git.removeWorktree({ path: first.worktree, repo: s.repo });
  const again = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'eng-13' });
  assert.equal(again.branch, 'eng-13');
  assert.equal(s.sh(again.worktree, 'rev-parse', 'HEAD'), mine);
  // checked out in the project folder itself: said so, with what to do there
  await git.removeWorktree({ path: again.worktree, repo: s.repo });
  s.sh(s.repo, 'switch', '--quiet', 'eng-13');
  assert.deepEqual(await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'eng-13' }), {
    ok: false,
    error: 'eng-13 is checked out in the project folder. Switch that folder to another branch first, or work there.',
  });
  s.sh(s.repo, 'switch', '--quiet', 'main');
  for (const bad of ['-x', 'a..b', 'a b'])
    assert.deepEqual(await git.worktreeAdd(s.repo, { root: s.root, newBranch: bad }), {
      ok: false,
      error: `Invalid branch name "${bad}".`,
    });
  // a base that doesn't exist says so
  assert.equal((await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'eng-14', branch: 'nowhere' })).ok, false);
});

test('a branch of that name only on origin (pushed earlier, or from another Mac) is fetched and worked on, tracking it', async (t) => {
  const s = setup(t);
  const other = path.join(path.dirname(s.repo), 'other');
  s.sh(path.dirname(s.repo), 'clone', '--quiet', s.sh(s.repo, 'remote', 'get-url', 'origin'), other);
  s.sh(other, 'switch', '--quiet', '-c', 'pat/eng-12-x');
  fs.writeFileSync(path.join(other, 'r.txt'), 'remote work');
  s.sh(other, 'add', '.');
  s.sh(other, 'commit', '--quiet', '-m', 'remote work');
  s.sh(other, 'push', '--quiet', 'origin', 'pat/eng-12-x');
  const pushed = s.sh(other, 'rev-parse', 'HEAD');
  const wt = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'pat/eng-12-x' });
  assert.equal(wt.ok, true, wt.error);
  assert.equal(s.sh(wt.worktree, 'rev-parse', 'HEAD'), pushed);
  assert.equal(s.sh(wt.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/pat/eng-12-x');
});

test('a branch deleted on origin since is not brought back; one MoPilot made that is behind origin is moved up', async (t) => {
  const s = setup(t);
  const originUrl = s.sh(s.repo, 'remote', 'get-url', 'origin');
  const other = path.join(path.dirname(s.repo), 'other');
  s.sh(path.dirname(s.repo), 'clone', '--quiet', originUrl, other);
  s.sh(other, 'switch', '--quiet', '-c', 'pat/eng-20');
  fs.writeFileSync(path.join(other, 'old.txt'), 'old merged work');
  s.sh(other, 'add', '.');
  s.sh(other, 'commit', '--quiet', '-m', 'old');
  s.sh(other, 'push', '--quiet', 'origin', 'pat/eng-20');
  // this Mac heard of it, then it was deleted on origin (its pull request merged)
  s.sh(s.repo, 'fetch', '--quiet', 'origin');
  s.sh(other, 'push', '--quiet', 'origin', '--delete', 'pat/eng-20');
  const wt = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'pat/eng-20' });
  assert.equal(wt.ok, true, wt.error);
  assert.equal(s.sh(wt.worktree, 'rev-parse', 'HEAD'), s.sh(s.repo, 'rev-parse', 'origin/main'));
  assert.throws(() => s.sh(wt.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'));
  assert.throws(() => s.sh(s.repo, 'rev-parse', '--verify', 'refs/remotes/origin/pat/eng-20'), 'the stale ref is gone');
  // pushed from this worktree, then moved on from another Mac: the next chat starts where origin is
  s.sh(wt.worktree, 'push', '--quiet', '-u', 'origin', 'pat/eng-20');
  await git.removeWorktree({ path: wt.worktree, repo: s.repo });
  s.sh(other, 'fetch', '--quiet', 'origin');
  s.sh(other, 'switch', '--quiet', '-C', 'pat/eng-20', 'origin/pat/eng-20');
  fs.writeFileSync(path.join(other, 'more.txt'), 'more');
  s.sh(other, 'add', '.');
  s.sh(other, 'commit', '--quiet', '-m', 'more');
  s.sh(other, 'push', '--quiet', 'origin', 'pat/eng-20');
  const again = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'pat/eng-20' });
  assert.equal(again.ok, true, again.error);
  assert.equal(s.sh(again.worktree, 'rev-parse', 'HEAD'), s.sh(other, 'rev-parse', 'HEAD'));
});

test('origin that can’t be reached, with a branch of that name heard of before, gives the usual name', async (t) => {
  const s = setup(t);
  s.sh(s.repo, 'update-ref', 'refs/remotes/origin/pat/eng-21', s.sh(s.repo, 'rev-parse', 'origin/main'));
  s.sh(s.repo, 'remote', 'set-url', 'origin', path.join(path.dirname(s.repo), 'nowhere.git'));
  const wt = await git.worktreeAdd(s.repo, { root: s.root, newBranch: 'pat/eng-21' });
  assert.equal(wt.ok, true, wt.error);
  assert.notEqual(wt.branch, 'pat/eng-21');
});
