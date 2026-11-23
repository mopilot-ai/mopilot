// Sidebar PR indicators preserve lifecycle, check health and merge readiness at the GitHub boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader } from '../src/lib/threadPullRequest.ts';
import { pullRequestDetails, pullRequestPresentation, type PullRequestDetails } from '../src/lib/pullRequestIndicator.ts';

const url = 'https://github.com/org/repo/pull/42';
const check = (status = 'COMPLETED', conclusion: string | null = 'SUCCESS') => ({ __typename: 'CheckRun', status, conclusion });

test('the sidebar reader retains checks and readiness from the same GitHub snapshot', async () => {
  const read = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => 'topic',
    gh: async () => ({
      ok: true,
      stdout: JSON.stringify({ url, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [check()] }),
    }),
  });
  assert.deepEqual(await read('chat', '/repo'), {
    url,
    number: 42,
    state: 'open',
    details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
  });
});

test('rollup decoding covers real check runs, commit contexts and every material boundary', () => {
  for (const [value, expected] of [
    [[], 'none'],
    [[check()], 'passing'],
    [[check('COMPLETED', 'NEUTRAL'), check('COMPLETED', 'SKIPPED')], 'passing'],
    ...['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING', 'EXPECTED'].map((s) => [[check(s, null)], 'pending']),
    ...['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].map((s) => [
      [check('COMPLETED', s)],
      'failing',
    ]),
    [[{ __typename: 'StatusContext', state: 'SUCCESS' }], 'passing'],
    [[{ __typename: 'StatusContext', state: 'FAILURE' }], 'failing'],
    [[{ __typename: 'StatusContext', state: 'PENDING' }], 'pending'],
    [[{ __typename: 'StatusContext', state: 'EXPECTED' }], 'pending'],
    [[null, check('COMPLETED', 'FAILURE')], 'failing'],
    [[check('IN_PROGRESS', ''), check('COMPLETED', 'FAILURE')], 'failing'],
    [[check(), check('IN_PROGRESS', '')], 'pending'],
    ...[
      undefined,
      null,
      {},
      'bad',
      [null],
      [[]],
      [true],
      [{}],
      [{ __typename: 'Other' }],
      [{ __typename: 'CheckRun' }],
      [check('UNKNOWN')],
      [check('COMPLETED', null)],
      [check('COMPLETED', 'STALE')],
      [{ __typename: 'StatusContext', state: null }],
      [{ __typename: 'StatusContext', state: 'SURPRISE' }],
      [check(), null],
      [check('IN_PROGRESS'), null],
    ].map((value) => [value, 'unknown']),
  ] as [unknown, string][]) {
    assert.equal(pullRequestDetails({ statusCheckRollup: value })?.checks, expected, JSON.stringify(value));
  }
  assert.equal(pullRequestDetails({}), undefined);
  assert.deepEqual(pullRequestDetails({ mergeable: 'CONFLICTING', mergeStateStatus: null }), {
    checks: 'unknown',
    mergeable: 'CONFLICTING',
    mergeState: 'UNKNOWN',
  });
  assert.deepEqual(pullRequestDetails({ statusCheckRollup: [], mergeable: 7, mergeStateStatus: 'BLOCKED', extra: true }), {
    checks: 'none',
    mergeable: 'UNKNOWN',
    mergeState: 'BLOCKED',
  });
});

test('PR lifecycle overrides old check details and open PRs expose every Codex indicator', () => {
  const details = (
    checks: PullRequestDetails['checks'],
    mergeable: PullRequestDetails['mergeable'] = 'MERGEABLE',
    mergeState = 'BLOCKED',
  ) => ({ checks, mergeable, mergeState });
  for (const state of ['merged', 'closed', 'unknown'] as const) {
    assert.deepEqual(pullRequestPresentation({ url, number: 42, state, details: details('failing') }), {
      indicator: state,
      label: state === 'unknown' ? 'status unavailable' : state,
    });
  }
  assert.deepEqual(pullRequestPresentation({ url, number: 42, state: 'open', source: 'response' }), { indicator: 'open', label: 'open' });
  for (const [value, indicator, label, dot] of [
    [details('passing', 'MERGEABLE', 'CLEAN'), 'ready', 'ready to merge', 'ready'],
    [details('none', 'MERGEABLE', 'HAS_HOOKS'), 'ready', 'ready to merge', 'ready'],
    [details('passing'), 'successful', 'checks passed', 'passing'],
    [details('passing', 'UNKNOWN', 'CLEAN'), 'successful', 'checks passed', 'passing'],
    [details('pending', 'MERGEABLE', 'CLEAN'), 'in_progress', 'checks pending', 'pending'],
    [details('none'), 'in_progress', 'waiting to merge', 'waiting'],
    [details('unknown'), 'open', 'checks unavailable', 'unknown'],
    [details('failing'), 'failing', 'checks failing', 'failing'],
    [details('passing', 'CONFLICTING'), 'failing', 'merge conflicts', 'conflict'],
    [details('unknown', 'UNKNOWN', 'DIRTY'), 'failing', 'merge conflicts', 'conflict'],
    // its author holds it: GitHub could merge it, the badge doesn't say ready
    [{ ...details('passing', 'MERGEABLE', 'CLEAN'), held: true }, 'open', 'held, not to merge yet', 'waiting'],
    [{ ...details('pending', 'MERGEABLE', 'CLEAN'), held: true }, 'in_progress', 'checks pending', 'pending'],
  ] as const) {
    const result = pullRequestPresentation({ url, number: 42, state: 'open', details: value });
    assert.equal(result.indicator, indicator);
    assert.equal(result.label, `open · ${label}`);
    assert.equal(result.dot, dot);
  }
});

test("the reader keeps a draft's checks and readiness, and drops a closed PR's", async () => {
  for (const [state, isDraft, details] of [
    ['OPEN', true, { checks: 'failing', mergeable: 'MERGEABLE', mergeState: 'DRAFT' }],
    ['CLOSED', false, undefined],
  ] as const) {
    const read = createPullRequestReader({
      attachments: async () => ({ data: [], nextCursor: null }),
      legacy: async () => null,
      head: async () => 'topic',
      gh: async () => ({
        ok: true,
        stdout: JSON.stringify({
          url,
          state,
          isDraft,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'DRAFT',
          statusCheckRollup: [check('COMPLETED', 'FAILURE')],
        }),
      }),
    });
    assert.deepEqual((await read('chat', '/repo'))?.details, details);
  }
});

test('failed refresh never combines cached green checks with reported lifecycle, and retry recovers', async () => {
  let available = true;
  const read = createPullRequestReader({
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    head: async () => 'topic',
    responses: async () => [{ status: 'completed', items: [{ type: 'agentMessage', text: 'PR #42 is open.' }] }],
    gh: async () => ({
      ok: available,
      stdout: JSON.stringify({ url, state: 'OPEN', title: 'PR', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }),
    }),
  });
  assert.equal(pullRequestPresentation((await read('chat', '/repo', true))!).indicator, 'ready');
  available = false;
  const unavailable = (await read('chat', '/repo', true))!;
  assert.equal(unavailable.source, 'response');
  assert.equal(unavailable.details, undefined);
  assert.equal(pullRequestPresentation(unavailable).indicator, 'open');
  available = true;
  assert.equal(pullRequestPresentation((await read('chat', '/repo', true))!).indicator, 'ready');
});

test('stale branch metadata cannot replace the current branch snapshot in either settle order', async () => {
  const { deferred } = await import('./support/async-scenarios.ts');
  for (const rejection of [false, true]) {
    for (const oldFirst of [false, true]) {
      const old = deferred<{ ok: boolean; stdout: string }>();
      const next = deferred<{ ok: boolean; stdout: string }>();
      const started = deferred();
      const replacement = deferred();
      let head = 'old';
      const read = createPullRequestReader({
        attachments: async () => ({ data: [], nextCursor: null }),
        legacy: async () => null,
        head: async () => head,
        gh: async (_, _cwd, branch) => {
          if (branch === 'old') {
            started.resolve(null);
            return old.promise;
          }
          replacement.resolve(null);
          return next.promise;
        },
      });
      const retired = read('chat', '/repo', true);
      await started.promise;
      head = 'new';
      const current = read('chat', '/repo', true);
      await replacement.promise;
      const finishOld = () =>
        rejection
          ? old.reject(new Error('retired'))
          : old.resolve({ ok: true, stdout: JSON.stringify({ url, state: 'OPEN', statusCheckRollup: [check()] }) });
      if (oldFirst) finishOld();
      next.resolve({
        ok: true,
        stdout: JSON.stringify({ url: url.replace('42', '43'), state: 'OPEN', statusCheckRollup: [check('IN_PROGRESS', null)] }),
      });
      assert.equal((await current)?.details?.checks, 'pending');
      if (!oldFirst) finishOld();
      assert.equal(await retired, null);
      assert.equal((await read('chat', '/repo'))?.number, 43);
    }
  }
});

test('a hold label marks the details held; a landing label alone or no labels do not', () => {
  const pr = (labels: unknown) => ({ statusCheckRollup: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', labels });
  assert.equal(pullRequestDetails(pr([{ name: 'do-not-merge' }]))!.held, true);
  const both = pullRequestDetails(pr([{ name: 'merge-on-green' }, { name: 'do-not-merge' }]))!;
  assert.deepEqual([both.held, both.landing], [true, true]);
  assert.equal(pullRequestDetails(pr([{ name: 'merge-on-green' }]))!.held, undefined);
  for (const labels of [undefined, null, [], [null, 'do-not-merge', { name: 7 }]])
    assert.equal(pullRequestDetails(pr(labels))!.held, undefined);
});
