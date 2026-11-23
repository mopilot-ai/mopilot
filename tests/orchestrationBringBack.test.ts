// electron/session/orchestration/bringBack.cjs: what git says a linked session did in its worktree (against a real
// repository, as git answers), and the user's Merge (refused over uncommitted changes, conflicts found by a dry run
// first) and Open PR (push, then GitHub's form), with every git and gh failure told rather than hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  RUNNERS,
  branchFacts,
  factsText,
  mergeBranch,
  openPullRequest,
  pullRequestOf,
} = require('../electron/session/orchestration/bringBack.cjs');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
/** A repository on main with a session's worktree on branch "kid" that changed `files`. */
function repo(t: any, files: Record<string, string> = { 'a.txt': 'one\ntwo\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bring-back-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  fs.mkdirSync(main);
  sh(main, 'init', '-q', '-b', 'main');
  sh(main, 'config', 'user.email', 't@t');
  sh(main, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-qm', 'init');
  const kid = path.join(dir, 'kid');
  sh(main, 'worktree', 'add', '-q', '-b', 'kid', kid);
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(kid, f), body);
  sh(kid, 'add', '-A');
  sh(kid, 'commit', '-qm', 'work');
  return { main, kid };
}
/** git as it is, gh answering `ghAnswer`. */
const real = (ghAnswer: any = { ok: false, stdout: '', stderr: 'no gh' }) => ({ git: RUNNERS.git, gh: async () => ghAnswer });

test('the facts are what git says: commits ahead, files and lines changed, uncommitted files, and the PR', async (t) => {
  const { main, kid } = repo(t, { 'a.txt': 'one\ntwo\n', 'b.txt': 'new\n' });
  fs.writeFileSync(path.join(kid, 'c.txt'), 'not committed\n');
  const pr = { ok: true, stdout: JSON.stringify([{ number: 12, state: 'OPEN', url: 'https://x/pr/12' }]), stderr: '' };
  const facts = await branchFacts(real(pr), { childCwd: kid, parentCwd: main, branch: 'kid' });
  assert.deepEqual(facts, {
    branch: 'kid',
    base: 'main',
    ahead: 1,
    files: 2,
    added: 2,
    removed: 0,
    uncommitted: 1,
    pr: { number: 12, state: 'OPEN', url: 'https://x/pr/12' },
  });
  assert.equal(
    factsText(facts),
    'Git (read by the app): branch kid, 1 commit ahead of main; 2 files changed (+2 -0); 1 file not committed in its worktree; pull request #12 (open).',
  );
  assert.equal(
    factsText({ ...facts, ahead: 2, files: 1, uncommitted: 0, pr: null }),
    'Git (read by the app): branch kid, 2 commits ahead of main; 1 file changed (+2 -0).',
  );
  // the parent on the session's own branch, a folder git can't read, or a branch git doesn't know: no facts
  assert.equal(await branchFacts(real(), { childCwd: kid, parentCwd: kid, branch: 'kid' }), null);
  assert.equal(await branchFacts(real(), { childCwd: kid, parentCwd: '/nonexistent', branch: 'kid' }), null);
  assert.equal(await branchFacts(real(), { childCwd: kid, parentCwd: main, branch: 'gone' }), null);
  sh(main, 'checkout', '-q', '--detach');
  assert.equal(await branchFacts(real(), { childCwd: kid, parentCwd: main, branch: 'kid' }), null, 'a detached parent has no branch');
});

test('facts from answers git gives oddly: a count that is not a number, a status git could not read', async () => {
  const git = async (args: string[], cwd: string) =>
    args[0] === 'rev-parse'
      ? { ok: true, stdout: cwd === '/p' ? 'main' : 'kid', stderr: '' }
      : args[0] === 'rev-list'
        ? { ok: true, stdout: 'many', stderr: '' }
        : args[0] === 'status'
          ? { ok: false, stdout: '', stderr: 'locked' }
          : { ok: true, stdout: '', stderr: '' };
  const facts = await branchFacts(
    { git, gh: async () => ({ ok: false, stdout: '', stderr: '' }) },
    { childCwd: '/k', parentCwd: '/p', branch: 'kid' },
  );
  assert.deepEqual([facts.ahead, facts.uncommitted, facts.files], [0, 0, 0]);
});

test('a PR is read from gh when its answer is one; anything else is no PR', async () => {
  const gh = (r: any) => ({ gh: async () => r }) as any;
  assert.equal(await pullRequestOf(gh({ ok: true, stdout: '[]', stderr: '' }), '/', 'b'), null);
  assert.equal(await pullRequestOf(gh({ ok: true, stdout: 'oops', stderr: '' }), '/', 'b'), null);
  assert.equal(await pullRequestOf(gh({ ok: true, stdout: '[{"number":"1","url":"u"}]', stderr: '' }), '/', 'b'), null);
  assert.equal(await pullRequestOf(gh({ ok: false, stdout: '', stderr: 'auth' }), '/', 'b'), null);
  // gh runs without a shell and always resolves, whether or not it is installed
  const ran = await RUNNERS.gh(['--version'], os.tmpdir(), 10_000);
  assert.equal(typeof ran.ok, 'boolean');
});

test('Merge brings the branch into the parent folder, refused over uncommitted changes, with conflicts found first', async (t) => {
  const clean = repo(t);
  const merged = await mergeBranch(real(), { parentCwd: clean.main, branch: 'kid' });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.into, 'main');
  assert.equal(merged.commit, sh(clean.main, 'rev-parse', '--short', 'HEAD'));
  assert.equal(fs.readFileSync(path.join(clean.main, 'a.txt'), 'utf8'), 'one\ntwo\n');
  // uncommitted changes to tracked files in the parent folder: nothing is touched
  const dirty = repo(t);
  fs.writeFileSync(path.join(dirty.main, 'a.txt'), 'edited here\n');
  const refused = await mergeBranch(real(), { parentCwd: dirty.main, branch: 'kid' });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, 'parent_dirty');
  assert.match(refused.message, /main has uncommitted changes/);
  // both sides changed the same lines: the dry run names the file and the folder is left as it was
  const clash = repo(t);
  fs.writeFileSync(path.join(clash.main, 'a.txt'), 'other\n');
  sh(clash.main, 'commit', '-qam', 'theirs');
  const head = sh(clash.main, 'rev-parse', 'HEAD');
  assert.deepEqual(await mergeBranch(real(), { parentCwd: clash.main, branch: 'kid' }), {
    status: 'conflicts',
    into: 'main',
    files: ['a.txt'],
  });
  assert.equal(sh(clash.main, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(clash.main, 'status', '--porcelain'), '');
  // a branch git doesn't know, a detached folder
  const unknown = await mergeBranch(real(), { parentCwd: clean.main, branch: 'gone' });
  assert.equal(unknown.reason, 'merge_check_failed');
  sh(clean.main, 'checkout', '-q', '--detach');
  assert.equal((await mergeBranch(real(), { parentCwd: clean.main, branch: 'kid' })).reason, 'no_branch');
});

test('a merge git refuses after a clean dry run is aborted and told', async () => {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'main\n', stderr: '' };
    if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
    if (args[0] === 'merge-tree') return { ok: true, stdout: 'tree\n', stderr: '' };
    if (args[0] === 'merge' && args[1] !== '--abort') return { ok: false, stdout: '', stderr: 'hook rejected\n' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const r = await mergeBranch({ git, gh: async () => ({ ok: true, stdout: '', stderr: '' }) }, { parentCwd: '/p', branch: 'kid' });
  assert.deepEqual(r, { status: 'refused', reason: 'merge_failed', message: 'Couldn’t merge kid: hook rejected' });
  assert.deepEqual(calls.at(-1), ['merge', '--abort']);
  // failures with nothing on stderr still say what failed
  const quiet = async (args: string[]) =>
    args[0] === 'rev-parse'
      ? { ok: true, stdout: 'main', stderr: '' }
      : args[0] === 'status'
        ? { ok: false, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: '' };
  assert.equal((await mergeBranch({ git: quiet, gh: quiet } as any, { parentCwd: '/p', branch: 'kid' })).reason, 'parent_dirty');
  const noStderr = async (args: string[]) =>
    args[0] === 'rev-parse'
      ? { ok: true, stdout: 'main', stderr: '' }
      : args[0] === 'status'
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: '' };
  assert.equal(
    (await mergeBranch({ git: noStderr, gh: noStderr } as any, { parentCwd: '/p', branch: 'kid' })).message,
    'Couldn’t check the merge: git failed',
  );
  const mergeQuiet = async (args: string[]) =>
    args[0] === 'rev-parse'
      ? { ok: true, stdout: 'main', stderr: '' }
      : args[0] === 'merge' && args[1] !== '--abort'
        ? { ok: false, stdout: '', stderr: '' }
        : { ok: true, stdout: '', stderr: '' };
  assert.equal(
    (await mergeBranch({ git: mergeQuiet, gh: mergeQuiet } as any, { parentCwd: '/p', branch: 'kid' })).message,
    'Couldn’t merge kid: git failed',
  );
});

test('Open PR pushes the branch, then opens GitHub’s form for it; a failed push or gh is told', async () => {
  const calls: any[] = [];
  const run = (push: any, form: any) => ({
    git: async (args: string[], cwd: string) => (calls.push(['git', args, cwd]), push),
    gh: async (args: string[], cwd: string) => (calls.push(['gh', args, cwd]), form),
  });
  const ok = { ok: true, stdout: '', stderr: '' };
  assert.deepEqual(await openPullRequest(run(ok, ok), { childCwd: '/kid', branch: 'kid' }), { status: 'opened' });
  assert.deepEqual(calls.splice(0), [
    ['git', ['push', '-u', 'origin', 'kid'], '/kid'],
    ['gh', ['pr', 'create', '--web', '--head', 'kid'], '/kid'],
  ]);
  const pushed = await openPullRequest(run({ ok: false, stdout: '', stderr: 'no remote\n' }, ok), { childCwd: '/kid', branch: 'kid' });
  assert.deepEqual(pushed, { status: 'refused', reason: 'push_failed', message: 'Couldn’t push kid: no remote' });
  assert.equal(
    (await openPullRequest(run({ ok: false, stdout: '', stderr: '' }, ok), { childCwd: '/kid', branch: 'kid' })).message,
    'Couldn’t push kid: git failed',
  );
  const form = await openPullRequest(run(ok, { ok: false, stdout: '', stderr: 'not logged in' }), { childCwd: '/kid', branch: 'kid' });
  assert.deepEqual(form, { status: 'refused', reason: 'gh_failed', message: 'Couldn’t open the pull request form: not logged in' });
  assert.equal(
    (await openPullRequest(run(ok, { ok: false, stdout: '', stderr: '' }), { childCwd: '/kid', branch: 'kid' })).message,
    'Couldn’t open the pull request form: gh failed',
  );
});

test('PR facts distinguish open drafts while completed PR state wins over stale draft flags', async () => {
  for (const [state, isDraft, expected] of [
    ['OPEN', true, 'DRAFT'],
    ['OPEN', false, 'OPEN'],
    ['MERGED', true, 'MERGED'],
    ['CLOSED', true, 'CLOSED'],
  ]) {
    let args: string[] = [];
    const result = await pullRequestOf(
      {
        gh: async (a: string[]) => {
          args = a;
          return { ok: true, stdout: JSON.stringify([{ number: 1, url: 'https://example.test/pr/1', state, isDraft }]), stderr: '' };
        },
      },
      '/owned',
      'branch',
    );
    assert.equal(result.state, expected);
    assert.equal(args.at(-1), 'number,state,url,isDraft');
  }
});
