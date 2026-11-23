// Merging a tracked pull request: the shared gate's states, the head pin, the repository's method and gh's refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePullRequest, ghRefusal } from '../electron/platform/prMerge.cjs';
import { mergeBlock } from '../shared/prMergeGate.mjs';

const url = 'https://github.com/o/r/pull/12';
const head = '0123456789abcdef0123456789abcdef01234567';
const moved = 'fedcba9876543210fedcba9876543210fedcba98';
const check = (extra = {}) => ({ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS', ...extra });
const view = (extra = {}) => ({
  url,
  title: 'Add merge',
  state: 'OPEN',
  headRefOid: head,
  headRefName: 'feature',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [check()],
  ...extra,
});
const methods = (extra = {}) => ({
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: true,
  viewerDefaultMergeMethod: 'SQUASH',
  ...extra,
});
/** A fake gh over one pull request and one repository; `merge` answers the write. */
function github(o: { pr?: any; repo?: any; merge?: { ok: boolean; stdout: string; stderr: string }; after?: any } = {}) {
  const calls: string[][] = [];
  let after: any = null;
  const answer = (value: any) => value?.raw ?? { ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
  const run = async (cmd: string, args: string[], opts: any) => {
    assert.equal(cmd, 'gh');
    assert.equal(opts.cwd, '/work');
    calls.push(args);
    if (args[1] === 'merge') {
      const result = o.merge ?? { ok: true, stdout: '', stderr: '' };
      // a merge GitHub took is what the next read says, unless the test says otherwise (`after`)
      if (result.ok || o.after) after = o.after ?? view({ state: 'MERGED' });
      return result;
    }
    return answer(args[0] === 'repo' ? (o.repo ?? methods()) : (after ?? o.pr ?? view()));
  };
  return { run, calls, merges: () => calls.filter((a) => a[1] === 'merge') };
}
const failed = (stderr: string) => ({ raw: { ok: false, stdout: '', stderr } });

test('the gate names what is in the way, and passes only a mergeable pull request with nothing failing or running', () => {
  const pr = (extra = {}) => ({ state: 'OPEN', mergeable: 'MERGEABLE', mergeState: 'CLEAN', failed: 0, pending: 0, ...extra });
  assert.equal(mergeBlock(pr()), null);
  assert.equal(mergeBlock(pr({ mergeState: 'HAS_HOOKS' })), null);
  const reason = (value: any) => mergeBlock(value)?.reason;
  assert.equal(reason(null), 'unread');
  assert.equal(reason(undefined), 'unread');
  assert.equal(reason(pr({ state: 'MERGED' })), 'merged');
  assert.equal(reason(pr({ state: 'CLOSED' })), 'closed');
  assert.equal(reason(pr({ mergeable: 'CONFLICTING' })), 'conflicts');
  assert.equal(reason(pr({ mergeState: 'DIRTY' })), 'conflicts');
  assert.equal(reason(pr({ mergeState: 'DRAFT' })), 'draft');
  assert.equal(reason(pr({ failed: 1, mergeState: 'BLOCKED' })), 'checks_failing');
  assert.equal(mergeBlock(pr({ failed: 1 }))!.message, '1 check is failing.');
  assert.equal(mergeBlock(pr({ failed: 2 }))!.message, '2 checks are failing.');
  // an optional check that fails or runs still blocks: the read cannot tell it from a required one
  assert.equal(reason(pr({ pending: 1, mergeState: 'UNSTABLE' })), 'checks_pending');
  assert.equal(mergeBlock(pr({ pending: 1 }))!.message, '1 check is still running.');
  assert.equal(mergeBlock(pr({ pending: 3 }))!.message, '3 checks are still running.');
  assert.equal(reason(pr({ mergeState: 'BEHIND' })), 'behind');
  // nothing failing or running, yet blocked: a required review, or a required check that never reported
  assert.equal(reason(pr({ mergeState: 'BLOCKED' })), 'protected');
  for (const unknown of [pr({ mergeable: 'UNKNOWN' }), pr({ mergeState: 'UNKNOWN' }), pr({ mergeState: undefined })])
    assert.equal(reason(unknown), 'computing');
  // a check that neither failed nor runs (neutral, stale) left it unstable: said so, not "still computing" forever
  assert.equal(reason(pr({ mergeState: 'UNSTABLE' })), 'unstable');
});

test('a ready pull request merges with the viewer’s default method, pinned to the head the user saw', async () => {
  const gh = github();
  assert.deepEqual(await mergePullRequest(gh.run, '/work', url, head), { status: 'merged', method: 'SQUASH' });
  assert.deepEqual(gh.merges(), [['pr', 'merge', url, '--match-head-commit', head, '--squash']]);
  assert.deepEqual(gh.calls[1], [
    'repo',
    'view',
    'o/r',
    '--json',
    'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod',
  ]);
  // never queued for later, forced past protection, or followed by a branch deletion
  for (const flag of ['--auto', '--admin', '--delete-branch']) assert.equal(gh.merges()[0].includes(flag), false);
  for (const [repo, flag, method] of [
    [methods({ viewerDefaultMergeMethod: 'REBASE' }), '--rebase', 'REBASE'],
    [methods({ viewerDefaultMergeMethod: 'MERGE' }), '--merge', 'MERGE'],
    // the default is not allowed here: the first allowed method
    [methods({ squashMergeAllowed: false }), '--merge', 'MERGE'],
    [methods({ squashMergeAllowed: false, mergeCommitAllowed: false, viewerDefaultMergeMethod: null }), '--rebase', 'REBASE'],
  ] as const) {
    const g = github({ repo });
    assert.deepEqual(await mergePullRequest(g.run, '/work', url, head), { status: 'merged', method });
    assert.equal(g.merges()[0].at(-1), flag);
  }
});

test('each state that is in the way is refused by name without a merge', async () => {
  const running = check({ status: 'IN_PROGRESS', conclusion: '' });
  const failing = check({ conclusion: 'FAILURE' });
  for (const [pr, reason] of [
    [view({ statusCheckRollup: [check(), running], mergeStateStatus: 'BLOCKED' }), 'checks_pending'],
    [view({ statusCheckRollup: [failing], mergeStateStatus: 'BLOCKED' }), 'checks_failing'],
    [view({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), 'conflicts'],
    [view({ mergeStateStatus: 'BLOCKED' }), 'protected'],
    [view({ mergeStateStatus: 'BEHIND' }), 'behind'],
    [view({ mergeStateStatus: 'DRAFT' }), 'draft'],
    [view({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), 'computing'],
    [view({ state: 'MERGED' }), 'merged'],
    [view({ state: 'CLOSED' }), 'closed'],
  ] as const) {
    const gh = github({ pr });
    const result: any = await mergePullRequest(gh.run, '/work', url, head);
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, reason);
    assert.ok(result.text);
    assert.equal(gh.merges().length, 0);
  }
});

test('a head that moved since the user looked is refused: before the write when the read sees it, by GitHub when it lands in between', async () => {
  const seen = github({ pr: view({ headRefOid: moved }) });
  const early: any = await mergePullRequest(seen.run, '/work', url, head);
  assert.equal(early.reason, 'head_moved');
  assert.match(early.text, /new commits since you looked/);
  assert.equal(seen.calls.length, 1);
  // the push lands after the read: gh's own --match-head-commit refuses, and that is what the user is told
  for (const stderr of [
    'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)',
    'HTTP 409: Head sha didn’t match the expected value',
    'expected head commit does not match',
  ]) {
    const raced = github({ merge: { ok: false, stdout: '', stderr } });
    const late: any = await mergePullRequest(raced.run, '/work', url, head);
    assert.equal(late.reason, 'head_moved');
    assert.equal(raced.merges().length, 1);
  }
});

test('branch protection, conflicts, sign-in and other failures from gh keep their own names', async () => {
  for (const [stderr, reason] of [
    ['GraphQL: Pull request is not mergeable: the base branch policy prohibits the merge. (mergePullRequest)', 'protected'],
    ['GraphQL: At least 1 approving review is required by reviewers with write access.', 'protected'],
    ['GraphQL: Repository rule violations found', 'protected'],
    ['GraphQL: Pull Request has merge conflicts', 'conflicts'],
    ['To get started with GitHub CLI, please run:  gh auth login', 'gh_auth'],
    // another pull request landed on the base during the click: not "new commits"
    ['GraphQL: Base branch was modified. Review and try the merge again.', 'base_moved'],
    ['', 'gh_failed'],
    ['GraphQL: Something went wrong', 'gh_failed'],
  ] as const) {
    const gh = github({ merge: { ok: false, stdout: '', stderr } });
    const result: any = await mergePullRequest(gh.run, '/work', url, head);
    assert.equal(result.status, 'refused');
    assert.equal(result.reason, reason);
  }
  assert.match(ghRefusal('GraphQL: protected branch hook declined').text, /^GitHub refused the merge: GraphQL: protected branch/);
  assert.match(ghRefusal('').text, /did not answer: it timed out or is not installed/);
});

test('an unreadable pull request or repository refuses instead of merging on a guess', async () => {
  // gh is not signed in: the read fails first
  const signedOut = github({ pr: failed('You are not logged into any GitHub hosts. To log in, run: gh auth login') });
  assert.equal(((await mergePullRequest(signedOut.run, '/work', url, head)) as any).reason, 'gh_auth');
  const missing = github({ pr: failed('') });
  assert.equal(((await mergePullRequest(missing.run, '/work', url, head)) as any).reason, 'gh_failed');
  for (const pr of [{ ...view(), mergeable: 'MAYBE' }, [], 'not json']) {
    const gh = github({ pr });
    const result: any = await mergePullRequest(gh.run, '/work', url, head);
    assert.equal(result.reason, 'gh_failed');
    assert.equal(gh.merges().length, 0);
  }
  for (const repo of [null, [], methods({ squashMergeAllowed: 'yes' }), failed('GraphQL: Could not resolve to a Repository')]) {
    const gh = github({ repo: repo ?? { raw: { ok: true, stdout: 'null', stderr: '' } } });
    const result: any = await mergePullRequest(gh.run, '/work', url, head);
    assert.equal(result.reason, 'gh_failed');
    assert.equal(gh.merges().length, 0);
  }
  const none = github({ repo: methods({ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false }) });
  assert.equal(((await mergePullRequest(none.run, '/work', url, head)) as any).reason, 'no_method');
  assert.equal(none.merges().length, 0);
});

test('a retired owner stops the merge before its write; a malformed request never reaches gh', async () => {
  const gh = github();
  let live = true;
  const run = async (cmd: string, args: string[], opts: any) => {
    const result = await gh.run(cmd, args, opts);
    // the chat is rebound while the repository's methods are read
    if (args[0] === 'repo') live = false;
    return result;
  };
  const result: any = await mergePullRequest(run, '/work', url, head, () => live);
  assert.equal(result.reason, 'retired');
  assert.equal(gh.merges().length, 0);
  for (const [link, sha] of [
    ['https://github.com/o/r/pull/12/', head],
    ['https://example.com/o/r/pull/12', head],
    [url, ''],
    [url, '--admin'],
    [url, undefined],
  ] as const)
    await assert.rejects(mergePullRequest(gh.run, '/work', link, sha as any), /Invalid pull request merge request/);
  assert.equal(gh.merges().length, 0);
});

test('gh’s exit is not the answer: only a pull request GitHub reports merged is merged', async () => {
  // a merge queue: gh exits 0 after queueing, and the pull request is still open
  const queued = github({ after: view() });
  const accepted: any = await mergePullRequest(queued.run, '/work', url, head);
  assert.equal(accepted.status, 'accepted');
  assert.match(accepted.text, /not merged yet/);
  // gh exited 0 and the confirming read failed: still not claimed as merged
  const unread = github({ after: failed('HTTP 502') });
  assert.equal(((await mergePullRequest(unread.run, '/work', url, head)) as any).status, 'accepted');
  // gh was killed at its time limit, but the merge landed: merged, not a failure
  const late = github({ merge: { ok: false, stdout: '', stderr: '' }, after: view({ state: 'MERGED' }) });
  assert.deepEqual(await mergePullRequest(late.run, '/work', url, head), { status: 'merged', method: 'SQUASH' });
  // it was killed and nothing landed: the silence is reported as silence
  const dead = github({ merge: { ok: false, stdout: '', stderr: '' } });
  const refused: any = await mergePullRequest(dead.run, '/work', url, head);
  assert.equal(refused.reason, 'gh_failed');
  assert.match(refused.text, /did not answer/);
});
