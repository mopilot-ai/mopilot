// A worktree on a pull request's branch with real git (electron/platform/prSource.cjs fetching, electron/platform/git.cjs worktreeAdd checking out and worktreeRestore bringing it back): origin's branch tracked, a local branch moved up only when behind, a fork's or merged pull request's head on pr/<n>, and what is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');
const { fetchPullRequest } = require('../electron/platform/prSource.cjs');

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'protocol.file.allow=always'];

/** origin (a bare repository with main, a pull request branch and a fork's pull request head), and a clone of it. */
function setup(t: any) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtpr-')));
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
  sh(seed, 'switch', '--quiet', '-c', 'fix-thing');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'fixed');
  sh(seed, 'commit', '--quiet', '-am', 'fix');
  const fixed = sh(seed, 'rev-parse', 'HEAD');
  sh(seed, 'push', '--quiet', 'origin', 'fix-thing');
  // a fork's head reaches origin only as refs/pull/<n>/head, as GitHub keeps it
  sh(seed, 'switch', '--quiet', '-c', 'theirs', 'main');
  fs.writeFileSync(path.join(seed, 'b.txt'), 'b');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '--quiet', '-m', 'theirs');
  const theirs = sh(seed, 'rev-parse', 'HEAD');
  sh(seed, 'push', '--quiet', 'origin', 'HEAD:refs/pull/7/head');
  // a merged pull request whose branch was deleted: only GitHub's refs/pull/<n>/head is left
  sh(seed, 'push', '--quiet', 'origin', `${fixed}:refs/pull/9/head`);
  const repo = path.join(home, 'app');
  sh(home, 'clone', '--quiet', origin, repo);
  // gh is faked to answer for origin as GitHub would; git runs for real
  const view = (n: number) =>
    JSON.stringify({
      number: n,
      title: 't',
      url: `https://github.com/acme/app/pull/${n}`,
      state: n === 9 ? 'MERGED' : 'OPEN',
      headRefName: n === 7 ? 'theirs' : n === 9 ? 'deleted-branch' : 'fix-thing',
      baseRefName: 'main',
      isCrossRepository: n === 7,
    });
  const run = (cmd: string, args: string[], o: { cwd: string }) =>
    new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
      if (cmd === 'gh') return resolve({ ok: true, stdout: view(Number(args[2])), stderr: '' });
      if (args[0] === 'remote') return resolve({ ok: true, stdout: 'https://github.com/acme/app.git\n', stderr: '' });
      execFile(
        'git',
        [...ID, '-c', `url.${origin}.insteadOf=https://github.com/acme/app.git`, ...args],
        { cwd: o.cwd },
        (e, stdout, stderr) => resolve({ ok: !e, stdout: String(stdout), stderr: String(stderr) }),
      );
    });
  const root = path.join(home, 'worktrees');
  const add = async (n: number) => {
    const pr = await fetchPullRequest(run, repo, n);
    assert.equal(pr.ok, true, pr.error);
    return git.worktreeAdd(repo, { root, branch: pr.base, checkout: pr.checkout, ...(pr.own ? {} : { pullRequest: pr.number }) });
  };
  return { home, repo, root, sh, fixed, theirs, add };
}

test('origin’s pull request branch is checked out tracking origin, and the worktree records its base', async (t) => {
  const s = setup(t);
  const wt = await s.add(12);
  assert.equal(wt.ok, true, wt.error);
  assert.equal(wt.branch, 'fix-thing');
  assert.equal(s.sh(wt.worktree, 'rev-parse', 'HEAD'), s.fixed);
  assert.equal(s.sh(wt.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/fix-thing');
  assert.equal(git.worktreeInfo(wt.worktree).sourceBranch, 'main');
  // with no base named, it records none rather than a guess
  await git.removeWorktree({ path: wt.worktree, repo: s.repo });
  const bare = await git.worktreeAdd(s.repo, { root: s.root, checkout: 'fix-thing' });
  assert.equal(bare.ok, true, bare.error);
  assert.equal(git.worktreeInfo(bare.worktree).sourceBranch ?? null, null);
});

test('a local branch only behind the pull request is moved up to it; one with commits of its own is kept as it is', async (t) => {
  const s = setup(t);
  s.sh(s.repo, 'branch', 'fix-thing', 'origin/main');
  const behind = await s.add(12);
  assert.equal(behind.ok, true, behind.error);
  assert.equal(s.sh(behind.worktree, 'rev-parse', 'HEAD'), s.fixed);
  await git.removeWorktree({ path: behind.worktree, repo: s.repo });
  // a commit of the user's that the pull request lacks
  s.sh(s.repo, 'branch', '-f', 'fix-thing', 'origin/main');
  const tree = s.sh(s.repo, 'rev-parse', 'origin/main^{tree}');
  const mine = s.sh(s.repo, 'commit-tree', '-p', 'origin/main', '-m', 'mine', tree);
  s.sh(s.repo, 'update-ref', 'refs/heads/fix-thing', mine);
  const kept = await s.add(12);
  assert.equal(kept.ok, true, kept.error);
  assert.equal(s.sh(kept.worktree, 'rev-parse', 'HEAD'), mine);
});

test('a fork’s head is checked out on pr/<n>, tracking nothing, and no ref of origin’s is written', async (t) => {
  const s = setup(t);
  const wt = await s.add(7);
  assert.equal(wt.ok, true, wt.error);
  assert.equal(wt.branch, 'pr/7');
  assert.equal(s.sh(wt.worktree, 'rev-parse', 'HEAD'), s.theirs);
  assert.throws(() => s.sh(wt.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'));
  assert.equal(s.sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/pr', 'refs/remotes/origin/theirs'), '');
});

test('a merged pull request whose branch was deleted is checked out from what GitHub keeps', async (t) => {
  const s = setup(t);
  const wt = await s.add(9);
  assert.equal(wt.ok, true, wt.error);
  assert.equal(wt.branch, 'pr/9');
  assert.equal(s.sh(wt.worktree, 'rev-parse', 'HEAD'), s.fixed);
});

test('a pull request’s worktree removed by auto-delete comes back on its branch, whose name has no id in it', async (t) => {
  const s = setup(t);
  for (const n of [12, 7]) {
    const wt = await s.add(n);
    assert.equal(wt.ok, true, wt.error);
    assert.equal(await git.removeWorktree({ path: wt.worktree, repo: s.repo }), true);
    assert.equal(fs.existsSync(path.dirname(wt.worktree)), false, 'its holder and marker went with it');
    const back = await git.worktreeRestore(wt.path, s.root, s.repo);
    assert.equal(back.ok, true, back.error);
    assert.equal(back.branch, wt.branch);
    assert.equal(s.sh(wt.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch);
  }
});

test('a worktree whose marker names a branch deleted since is not brought back', async (t) => {
  const s = setup(t);
  const wt = await s.add(12);
  assert.equal(wt.ok, true, wt.error);
  // its folder deleted by hand, its marker left beside it, and the branch deleted after
  fs.rmSync(wt.worktree, { recursive: true, force: true });
  s.sh(s.repo, 'worktree', 'prune');
  s.sh(s.repo, 'branch', '-D', 'fix-thing');
  const id = path.basename(path.dirname(wt.worktree));
  assert.deepEqual(await git.worktreeRestore(wt.path, s.root, s.repo), {
    ok: false,
    error: `The branch for this worktree (…/${id}) is gone`,
  });
});

test('a branch that was never fetched, or a name that is an option or a ref expression, makes nothing', async (t) => {
  const s = setup(t);
  assert.deepEqual(await git.worktreeAdd(s.repo, { root: s.root, branch: 'main', checkout: 'nowhere' }), {
    ok: false,
    error: 'Branch nowhere was not fetched. Try again.',
  });
  for (const bad of ['-x', 'main@{1}', 'a..b', 'a b', '', 3])
    assert.deepEqual(await git.worktreeAdd(s.repo, { root: s.root, branch: 'main', checkout: bad }), {
      ok: false,
      error: `Invalid branch name "${bad}".`,
    });
  assert.equal(fs.existsSync(s.root) ? fs.readdirSync(s.root).length : 0, 0);
});

test('a second chat from the same pull request is told where its branch is checked out, and makes nothing', async (t) => {
  const s = setup(t);
  const first = await s.add(12);
  assert.equal(first.ok, true, first.error);
  const second = await s.add(12);
  assert.deepEqual(second, {
    ok: false,
    error: `fix-thing is already checked out in ${first.worktree}. Work there, or remove that worktree first.`,
  });
  assert.equal(fs.readdirSync(s.root).length, 1);
  // so is the project folder itself when it is on that branch, said as such
  await git.removeWorktree({ path: first.worktree, repo: s.repo });
  s.sh(s.repo, 'switch', '--quiet', 'fix-thing');
  assert.equal(
    (await s.add(12)).error,
    'fix-thing is checked out in the project folder. Switch that folder to another branch first, or work there.',
  );
});
