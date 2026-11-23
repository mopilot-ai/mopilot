// "Delete branch on archive" with real git (electron/platform/worktreeArchive.cjs, platform/deletedBranch.cjs and the IPC): a managed worktree and its branch go only when nothing on them can be lost, else both stay with why; restoring the worktree later makes the branch again with its own config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const git = require('../electron/platform/git.cjs');
const { archiveWorktree, setChatFolders } = require('../electron/platform/worktreeArchive.cjs');
const { bringBackDeleted, recordDeleted } = require('../electron/platform/deletedBranch.cjs');
const { git: runGit } = require('../electron/platform/gitRun.cjs');
const { register } = require('../electron/app/ipc/worktreeArchive.cjs');

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
const none = async () => [];

/** origin (bare, with main) and a clone of it, with managed worktrees under `root`. */
function setup(t: any) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtarch-')));
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
  fs.writeFileSync(path.join(seed, '.gitignore'), '.env\nnode_modules/\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '--quiet', '-m', 'first');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '--quiet', 'origin', 'main');
  const repo = path.join(home, 'app');
  sh(home, 'clone', '--quiet', origin, repo);
  const root = path.join(home, 'worktrees');
  const add = async () => {
    const wt = await git.worktreeAdd(repo, { root });
    assert.equal(wt.ok, true, wt.error);
    return wt;
  };
  const commit = (dir: string, name: string) => {
    fs.writeFileSync(path.join(dir, name), name);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '--quiet', '-m', name);
  };
  const branches = () => sh(repo, 'branch', '--format=%(refname:short)').split('\n');
  const archive = (wt: any, folders: () => Promise<string[] | null> = none) => archiveWorktree(wt.worktree, { folders });
  return { home, repo, root, origin, sh, add, commit, branches, archive };
}

test('a worktree whose every commit is on origin goes with its branch; restoring it later makes the branch again with its upstream', async (t) => {
  const s = setup(t);
  const wt = await s.add();
  s.commit(wt.worktree, 'done.txt');
  s.sh(wt.worktree, 'push', '--quiet', '-u', 'origin', `HEAD:refs/heads/${wt.branch}`);
  // a value with a newline in it comes back whole, and can't pass for another key
  s.sh(s.repo, 'config', `branch.${wt.branch}.description`, `line one\nbranch.${wt.branch}.pushremote evil`);
  // what a rebuild makes anyway may be in it
  fs.mkdirSync(path.join(wt.worktree, 'node_modules'));
  fs.writeFileSync(path.join(wt.worktree, 'node_modules', 'x.js'), 'x');
  const sha = s.sh(wt.worktree, 'rev-parse', 'HEAD');
  assert.deepEqual(await s.archive(wt), { ok: true, removed: true, deleted: { branch: wt.branch } });
  assert.equal(fs.existsSync(wt.worktree), false);
  assert.equal(s.branches().includes(wt.branch), false);
  // Undo and a later unarchive both restore the worktree, which finds the record
  const back = await git.worktreeRestore(wt.path, s.root, s.repo);
  assert.equal(back.ok, true, back.error);
  assert.equal(back.branch, wt.branch);
  assert.equal(s.sh(wt.worktree, 'rev-parse', 'HEAD'), sha);
  assert.equal(s.sh(wt.worktree, 'rev-parse', '--abbrev-ref', '@{upstream}'), `origin/${wt.branch}`);
  assert.equal(s.sh(s.repo, 'config', '--get', `branch.${wt.branch}.description`), `line one\nbranch.${wt.branch}.pushremote evil`);
  assert.throws(() => s.sh(s.repo, 'config', '--get', `branch.${wt.branch}.pushremote`));
  assert.throws(() => s.sh(s.repo, 'config', '--get-regexp', '^mopilotdeleted\\.'), 'the record went with the restore');
});

test('a worktree whose branch was deleted by hand, with no record, is still said to be gone', async (t) => {
  const s = setup(t);
  const wt = await s.add();
  assert.equal(await git.removeWorktree({ path: wt.worktree, repo: s.repo }), true);
  s.sh(s.repo, 'branch', '-D', wt.branch);
  const back = await git.worktreeRestore(wt.path, s.root, s.repo);
  assert.equal(back.ok, false);
  assert.match(back.error, /is gone$/);
});

test('a fresh worktree, or one whose commits are on another local branch, loses nothing: it goes too', async (t) => {
  const s = setup(t);
  const fresh = await s.add();
  assert.equal((await s.archive(fresh)).removed, true);
  const merged = await s.add();
  s.commit(merged.worktree, 'b.txt');
  s.sh(s.repo, 'branch', 'keep-it', merged.branch);
  assert.equal((await s.archive(merged)).removed, true);
  assert.deepEqual(s.branches().sort(), ['keep-it', 'main']);
});

test('what could be lost keeps the worktree and its branch, saying why', async (t) => {
  const s = setup(t);
  const kept = async (wt: any, why: string | RegExp, folders?: () => Promise<string[] | null>) => {
    const r = await s.archive(wt, folders);
    assert.equal(r.removed, false);
    if (typeof why === 'string') assert.equal(r.kept, `Kept the worktree and its branch: ${why}.`);
    else assert.match(r.kept, why);
    assert.equal(fs.existsSync(wt.worktree), true);
  };
  const ahead = await s.add();
  s.commit(ahead.worktree, 'one.txt');
  await kept(ahead, `${ahead.branch} has a commit not pushed or on another branch`);
  s.commit(ahead.worktree, 'two.txt');
  await kept(ahead, /has 2 commits not pushed/);
  const dirty = await s.add();
  fs.writeFileSync(path.join(dirty.worktree, 'new.txt'), 'x');
  await kept(dirty, /uncommitted changes/);
  // an ignored file is no change git shows, but it is gone with the checkout
  const ignored = await s.add();
  fs.writeFileSync(path.join(ignored.worktree, '.env'), 'KEY=1');
  await kept(ignored, /ignored files that are not rebuildable/);
  const detached = await s.add();
  s.sh(detached.worktree, 'switch', '--quiet', '--detach');
  await kept(detached, 'it is not on a branch');
  const merging = await s.add();
  fs.writeFileSync(
    s.sh(merging.worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'),
    s.sh(s.repo, 'rev-parse', 'HEAD'),
  );
  await kept(merging, 'a merge, rebase or other git operation is under way in it');
  const sub = await s.add();
  fs.writeFileSync(path.join(sub.worktree, '.gitmodules'), '[submodule "x"]\n');
  await kept(sub, 'it has submodules');
  // a chat main knows (started while the cleanup script ran) still works there, or main can't say
  const used = await s.add();
  await kept(used, 'another chat works in it', async () => [path.join(used.worktree, 'src')]);
  await kept(used, 'the open chats couldn’t be read', async () => null);
  // a change made while the remote was checked (a terminal in the folder) is seen just before removal
  await kept(used, /uncommitted changes/, async () => (fs.writeFileSync(path.join(used.worktree, 'late.txt'), 'x'), []));
  fs.rmSync(path.join(used.worktree, 'late.txt'));
  setChatFolders(null);
  assert.equal((await archiveWorktree(used.worktree)).kept, 'Kept the worktree and its branch: the open chats couldn’t be read.');
  setChatFolders(async () => []);
  assert.equal((await archiveWorktree(used.worktree)).removed, true);
  setChatFolders(null);
});

test('a commit only a stale remote-tracking ref still has is not pushed: the remote is fetched first, and one that can’t be reached keeps it', async (t) => {
  const s = setup(t);
  const wt = await s.add();
  s.commit(wt.worktree, 'pushed-once.txt');
  s.sh(wt.worktree, 'push', '--quiet', 'origin', `HEAD:refs/heads/${wt.branch}`);
  // deleted on origin since; this repository still has origin/<branch>
  s.sh(s.origin, 'update-ref', '-d', `refs/heads/${wt.branch}`);
  assert.match((await s.archive(wt)).kept, /has a commit not pushed/);
  // the check fetched into a namespace of its own and removed it: no remote-tracking ref was pruned or changed
  assert.equal(s.sh(s.repo, 'rev-parse', `origin/${wt.branch}`), s.sh(wt.worktree, 'rev-parse', 'HEAD'));
  assert.equal(s.sh(s.repo, 'for-each-ref', 'refs/mopilot/'), '');
  s.sh(s.repo, 'remote', 'set-url', 'origin', path.join(s.home, 'nowhere.git'));
  assert.equal((await s.archive(wt)).kept, 'Kept the worktree and its branch: the remote couldn’t be reached to check what is pushed.');
});

test('a worktree adopted in place, or a folder that is no MoPilot worktree, is never removed from here', async (t) => {
  const s = setup(t);
  const theirs = path.join(s.home, 'conductor', 'tokyo');
  s.sh(s.repo, 'worktree', 'add', '--quiet', '-b', 'tokyo', theirs);
  assert.equal((await git.worktreeAdopt(theirs)).ok, true);
  assert.equal((await archiveWorktree(theirs, { folders: none })).kept, 'Kept the worktree and its branch: it was made outside MoPilot.');
  assert.equal(fs.existsSync(theirs), true);
  for (const bad of [s.repo, 'relative/path', null])
    assert.deepEqual(await archiveWorktree(bad), { ok: false, error: 'Not a MoPilot worktree.' });
});

test('git failing at any step keeps what it could not check, and nothing is deleted without its record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtarch-fake-'));
  const info = () => ({ path: path.join(dir, 'app'), repo: '/w/app' });
  fs.mkdirSync(path.join(dir, 'app', '.git'), { recursive: true });
  const sha = 'a'.repeat(40);
  const calls: string[][] = [];
  type Answer = { ok: boolean; stdout?: string; stderr?: string };
  const answers = (over: Record<string, Answer | ((args: string[]) => Answer)>) => async (args: string[]) => {
    calls.push(args);
    const base: Record<string, Answer | ((args: string[]) => Answer)> = {
      'symbolic-ref': { ok: true, stdout: 'mopilot/1\n' },
      'rev-parse': (a) => (a.includes('--git-path') ? { ok: true, stdout: 'x/MERGE_HEAD\n' } : { ok: true, stdout: `${sha}\n` }),
      status: { ok: true },
      remote: { ok: true, stdout: 'origin\n' },
      fetch: { ok: true },
      'for-each-ref': { ok: true, stdout: 'refs/mopilot/archive-check/1/origin/x\n' },
      'update-ref': { ok: true },
      'rev-list': { ok: true, stdout: '0\n' },
      config: (a) => (a.includes('--get-regexp') ? { ok: true, stdout: 'branch.mopilot/1.remote\norigin\0' } : { ok: true }),
      branch: { ok: true },
      ...over,
    };
    const a = base[args[0]];
    return { stdout: '', stderr: '', ...((typeof a === 'function' ? a(args) : a) ?? { ok: false }) };
  };
  const run = (over: Record<string, any>, remove = async () => true) =>
    archiveWorktree(path.join(dir, 'app'), { git: answers(over), info, remove, folders: none });
  try {
    assert.match((await run({ 'rev-parse': (a: string[]) => ({ ok: !a.includes('--git-path') }) })).kept, /git operation is under way/);
    assert.match((await run({ status: { ok: false } })).kept, /unreadable status/);
    assert.match(
      (await run({ 'rev-parse': (a: string[]) => ({ ok: true, stdout: a.includes('--git-path') ? '' : 'nope' }) })).kept,
      /commits couldn’t be checked/,
    );
    assert.match((await run({ remote: { ok: false } })).kept, /commits couldn’t be checked/);
    assert.match((await run({ remote: { ok: true, stdout: 'bad name\n' } })).kept, /commits couldn’t be checked/);
    assert.match((await run({ fetch: { ok: false } })).kept, /remote couldn’t be reached/);
    assert.match((await run({ 'rev-list': { ok: false } })).kept, /commits couldn’t be checked/);
    assert.match((await run({ 'rev-list': { ok: true, stdout: '' } })).kept, /commits couldn’t be checked/);
    assert.match((await run({ 'rev-list': { ok: true, stdout: 'x' } })).kept, /commits couldn’t be checked/);
    // the branch's config can't be read, or its record can't be written: nothing is removed
    for (const config of [
      (a: string[]) => (a.includes('--get-regexp') ? { ok: false, stderr: 'bad config' } : { ok: true }),
      (a: string[]) =>
        a.includes('--get-regexp') ? { ok: true, stdout: 'branch.mopilot/1.flag\0' } : { ok: !a.some((x) => x.endsWith('.sha')) },
    ]) {
      let removed = false;
      const r = await run({ config }, async () => ((removed = true), true));
      assert.equal(r.kept, 'Kept the worktree and its branch: the branch couldn’t be recorded to bring it back.');
      assert.equal(removed, false);
    }
    calls.length = 0;
    assert.match((await run({}, async () => false)).kept, /the worktree couldn’t be removed/);
    assert.ok(
      calls.some((a) => a.join(' ').startsWith('config --remove-section')),
      'its record is dropped again',
    );
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (line: string) => warned.push(line);
    try {
      assert.deepEqual(await run({ branch: { ok: false, stderr: 'error: locked' } }), {
        ok: true,
        removed: true,
        kept: 'Removed the worktree, but couldn’t delete mopilot/1.',
      });
    } finally {
      console.warn = warn;
    }
    assert.match(warned[0], /error: locked/);
    calls.length = 0;
    assert.deepEqual(await run({}), { ok: true, removed: true, deleted: { branch: 'mopilot/1' } });
    const at = (cmd: string) => calls.findIndex((a) => a.join(' ').startsWith(cmd));
    // recorded before it is deleted, and the check's own refs are removed
    assert.ok(at(`config mopilotdeleted.${path.basename(dir)}.sha ${sha}`) < at('branch -D'));
    assert.ok(at('update-ref -d refs/mopilot/archive-check/') > 0);
    // the fetch never waits on a password prompt
    assert.ok(calls.some((a) => a[0] === 'fetch' && a.includes('--no-write-fetch-head')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a record brings back only a valid branch, only its own config, and says when its commit is gone', async (t) => {
  const s = setup(t);
  const sha = s.sh(s.repo, 'rev-parse', 'HEAD');
  await recordDeleted(
    s.repo,
    'w1',
    {
      branch: 'fix-thing',
      sha,
      config: [
        ['branch.fix-thing.remote', 'origin'],
        ['core.hooksPath', '/evil'],
        ['branch.fix-thing.merge', 'refs/heads/fix-thing'],
      ],
    },
    runGit,
  );
  assert.deepEqual(await bringBackDeleted(s.repo, 'w1', runGit), { ok: true, branch: 'fix-thing' });
  assert.equal(s.sh(s.repo, 'config', '--get', 'branch.fix-thing.remote'), 'origin');
  assert.throws(() => s.sh(s.repo, 'config', '--get', 'core.hooksPath'));
  // once used it is gone; one with nothing valid in it is no record
  assert.equal(await bringBackDeleted(s.repo, 'w1', runGit), null);
  for (const [branch, recorded] of [
    ['a..b', sha],
    ['-x', sha],
    ['b', 'HEAD'],
  ]) {
    await recordDeleted(s.repo, 'w2', { branch, sha: recorded, config: [] }, runGit);
    assert.equal(await bringBackDeleted(s.repo, 'w2', runGit), null, branch);
  }
  assert.equal(await bringBackDeleted(s.repo, '../x', runGit), null);
  // a branch of that name made since is used as it is
  await recordDeleted(s.repo, 'w3', { branch: 'main', sha: 'b'.repeat(40), config: [['branch.main.extra', 'x']] }, runGit);
  assert.deepEqual(await bringBackDeleted(s.repo, 'w3', runGit), { ok: true, branch: 'main' });
  assert.throws(() => s.sh(s.repo, 'config', '--get', 'branch.main.extra'));
  await recordDeleted(s.repo, 'w4', { branch: 'lost', sha: 'b'.repeat(40), config: [] }, runGit);
  assert.deepEqual(await bringBackDeleted(s.repo, 'w4', runGit), {
    ok: false,
    error: 'The branch for this worktree (…/w4) was deleted on archive, and its commit is gone',
  });
});

test('the IPC hands the archive to main’s code', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  register({ handle: (name: string, fn: (...a: any[]) => any) => handlers.set(name, fn) });
  assert.deepEqual(await handlers.get('git:worktreeArchive')!({}, 'rel'), { ok: false, error: 'Not a MoPilot worktree.' });
});
