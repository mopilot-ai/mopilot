// src/lib/prInbox.ts: which of a chat family's PRs need the user, which move without them and which landed today, on
// every harness (the inbox reads only the PR, the PR monitor and the session's state), and the pill's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, inboxCount, inboxView, landedWhen, startOfDay, TAG_WORD, type InboxSource } from '../src/lib/prInbox.ts';
import { LANDING_LABELS, pullRequestDetails } from '../src/lib/pullRequestIndicator.ts';

const SINCE = 1_000;
const details = (o: any = {}) => ({ checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN', ...o });
const src = (o: Partial<InboxSource> & { d?: any } = {}): InboxSource => {
  const { d, ...rest } = o as any;
  return {
    url: 'https://github.com/o/r/pull/1',
    chatId: 'c',
    session: 'api',
    pr: { url: 'https://github.com/o/r/pull/1', number: 1, state: 'open', title: 'T', details: details(d) },
    ask: null,
    monitor: null,
    ...rest,
  };
};
const place = (s: InboxSource) => {
  const r = classify(s, SINCE);
  return r && [r.group, r.tag, r.text, r.step];
};
const pr = (o: any) => ({ url: 'u', number: 1, ...o });

test('closed PRs and merges before today have no place; a merge today is landed', () => {
  assert.equal(place(src({ pr: pr({ state: 'closed' }) })), null);
  assert.equal(place(src({ pr: pr({ state: 'merged', mergedAt: SINCE - 1 }) })), null);
  assert.equal(place(src({ pr: pr({ state: 'merged' }) })), null);
  assert.deepEqual(place(src({ pr: pr({ state: 'merged', mergedAt: SINCE }) })), ['landed', 'landed', 'Merged', null]);
});

test('no limit keeps every merge, newest first and one of unknown date last; a closed PR still has no place', () => {
  const merged = (url: string, mergedAt?: number) => src({ url, pr: pr({ url, state: 'merged', mergedAt }) });
  assert.equal(classify(src({ pr: pr({ state: 'closed' }) }), null), null);
  const v = inboxView([merged('none'), merged('old', 1), merged('new', 2), merged('also none')], null);
  assert.deepEqual(
    v.landed.map((r) => r.url),
    ['new', 'old', 'none', 'also none'],
  );
});

test('a session waiting on the user asks, with its question', () => {
  const ask = { text: 'Keep the alias?', actions: [{ label: 'Keep', message: null }] };
  assert.deepEqual(place(src({ asking: true, ask })), ['needs', 'asks', 'Keep the alias?', null]);
  assert.deepEqual(place(src({ asking: true })), ['needs', 'asks', 'Waiting for your answer or approval', null]);
});

test('a stopped or unconfirmed auto-fix is stuck, before anything GitHub says', () => {
  const monitor = (o: any) => ({ autoFix: true, limited: false, uncertain: false, ...o });
  assert.deepEqual(place(src({ monitor: monitor({ limited: true }), pr: null })), [
    'moving',
    'stuck',
    'Auto-fix stopped after several tries',
    null,
  ]);
  assert.deepEqual(place(src({ monitor: monitor({ uncertain: true }) })), [
    'moving',
    'stuck',
    'Auto-fix may not have reached the session',
    null,
  ]);
});

test('a PR GitHub did not answer for moves as unknown, never needing the user', () => {
  for (const p of [null, pr({ state: 'unknown' }), pr({ state: 'open' })])
    assert.deepEqual(place(src({ pr: p })), ['moving', 'unknown', 'Status unavailable', null]);
});

test('failing checks and conflicts need the user only when nothing is fixing them', () => {
  assert.deepEqual(place(src({ d: { checks: 'failing' } })), ['moving', 'stuck', 'Checks failing · auto-fix is off', null]);
  assert.deepEqual(place(src({ d: { mergeable: 'CONFLICTING' } })), ['moving', 'stuck', 'Merge conflict · auto-fix is off', null]);
  assert.deepEqual(place(src({ d: { mergeState: 'DIRTY' } })), ['moving', 'stuck', 'Merge conflict · auto-fix is off', null]);
  const autoFix = { autoFix: true, limited: false, uncertain: false };
  assert.deepEqual(place(src({ d: { checks: 'failing' }, monitor: autoFix })), ['moving', 'fixing', 'Checks failing · being fixed', null]);
  assert.deepEqual(place(src({ d: { mergeable: 'CONFLICTING' }, busy: true })), ['moving', 'fixing', 'Merge conflict · being fixed', null]);
});

test('drafts, running checks and auto-landing PRs are on their way', () => {
  assert.deepEqual(place(src({ pr: pr({ state: 'draft', details: details() }) })), ['moving', 'draft', 'Draft', 'checks']);
  assert.deepEqual(place(src({ d: { checks: 'pending' } })), ['moving', 'checks', 'Checks running', 'checks']);
  assert.deepEqual(place(src({ d: { checks: 'unknown' } })), ['moving', 'checks', 'Checks unavailable', 'checks']);
  assert.deepEqual(place(src({ d: { landing: true } })), ['moving', 'merging', 'Merges once it can', 'merge']);
});

test("a PR its author holds with do-not-merge is on its way, never the user's to merge", () => {
  // ready on GitHub, and nothing will merge it: still not the user's, its author said not yet
  assert.deepEqual(place(src({ d: { held: true } })), ['moving', 'held', 'Held · do-not-merge', 'merge']);
  // the hold wins over a landing label the sweep has not taken off yet
  assert.deepEqual(place(src({ d: { held: true, landing: true } })), ['moving', 'held', 'Held · do-not-merge', 'merge']);
  // checks still running say so; failing checks nothing fixes still need the user
  assert.deepEqual(place(src({ d: { held: true, checks: 'pending' } })), ['moving', 'checks', 'Checks running', 'checks']);
  assert.deepEqual(place(src({ d: { held: true, checks: 'failing' } })), ['moving', 'stuck', 'Checks failing · auto-fix is off', null]);
});

test('a ready PR nothing will merge needs the user, unless its session is still at work', () => {
  assert.deepEqual(place(src({ d: { mergeState: 'HAS_HOOKS', checks: 'none' } })), [
    'moving',
    'merge',
    'Checks passed · nothing set to merge it',
    null,
  ]);
  assert.deepEqual(place(src({ busy: true })), ['moving', 'waiting', 'Waiting to merge', 'merge']);
  assert.deepEqual(place(src({ d: { mergeState: 'BEHIND' } })), ['moving', 'waiting', 'Behind its base branch', 'merge']);
  assert.deepEqual(place(src({ d: { mergeState: 'BLOCKED' } })), ['moving', 'waiting', 'Waiting for a review or a branch rule', 'merge']);
  assert.deepEqual(place(src({ d: { mergeState: 'UNSTABLE' } })), ['moving', 'waiting', 'Some optional checks failed', 'merge']);
  assert.deepEqual(place(src({ d: { mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' } })), ['moving', 'waiting', 'Waiting to merge', 'merge']);
});

test('the view lists each PR once: only questions need the user; on its way, what they may act on, then nearness to landing', () => {
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  const at = (n: number, o: any) => src({ url: url(n), chatId: `c${n}`, ...o });
  const v = inboxView(
    [
      at(1, { d: { checks: 'failing' } }),
      at(2, { asking: true }),
      at(1, { asking: true }),
      at(3, {}),
      at(4, { d: { checks: 'pending' } }),
      at(5, { d: { landing: true } }),
      at(6, { pr: pr({ state: 'merged', mergedAt: SINCE + 1 }) }),
      at(7, { pr: pr({ state: 'merged', mergedAt: SINCE + 9 }) }),
      at(8, { pr: pr({ state: 'closed' }) }),
    ],
    SINCE,
  );
  // only a question needs the user; what they may act on leads the PRs on their way
  assert.deepEqual(
    v.needs.map((r) => [r.chatId, r.tag]),
    [['c2', 'asks']],
  );
  assert.deepEqual(
    v.moving.map((r) => r.chatId),
    ['c1', 'c3', 'c5', 'c4'],
  );
  assert.deepEqual(
    v.landed.map((r) => r.chatId),
    ['c7', 'c6'],
  );
});

test('the count names what merged and what is open, and nothing with neither', () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({}) as any);
  assert.equal(inboxCount({ needs: [], moving: [], landed: [] }), null);
  assert.deepEqual(inboxCount({ needs: [], moving: [], landed: rows(2) }), { label: '2 merged PRs', aria: 'Pull requests: 2 merged' });
  assert.deepEqual(inboxCount({ needs: rows(1), moving: rows(1), landed: [] }), { label: '2 open PRs', aria: 'Pull requests: 2 open' });
  assert.deepEqual(inboxCount({ needs: rows(3), moving: rows(4), landed: rows(7) }), {
    label: '7 merged PRs · 7 open PRs',
    aria: 'Pull requests: 7 merged, 7 open',
  });
});

test('the visible PR count names its subject when alone or beside another count', () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({}) as any);
  const cases = [
    [0, 1, 0, '1 open PR'],
    [1, 0, 0, '1 open PR'],
    [1, 1, 0, '2 open PRs'],
    [0, 0, 1, '1 merged PR'],
    [0, 0, 2, '2 merged PRs'],
    [1, 0, 1, '1 merged PR · 1 open PR'],
    [0, 2, 1, '1 merged PR · 2 open PRs'],
    [1, 0, 2, '2 merged PRs · 1 open PR'],
    [1, 1, 2, '2 merged PRs · 2 open PRs'],
  ] as const;
  for (const [needs, moving, landed, label] of cases) {
    assert.equal(inboxCount({ needs: rows(needs), moving: rows(moving), landed: rows(landed) })?.label, label);
  }
});

test('a merged row says when: today with its time, yesterday, else its date, and its year when not this year', () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  assert.match(landedWhen(new Date(2026, 10, 4, 0, 0).getTime(), now), /^Today .*\d:00/);
  assert.equal(landedWhen(new Date(2026, 10, 3, 23, 59).getTime(), now), 'Yesterday');
  assert.equal(landedWhen(new Date(2026, 10, 3, 0, 0).getTime(), now), 'Yesterday');
  assert.equal(landedWhen(new Date(2026, 10, 2, 23, 59).getTime(), now), 'Nov 2');
  assert.equal(landedWhen(new Date(2025, 11, 31).getTime(), now), 'Dec 31, 2025');
});

test('today starts at local midnight', () => {
  const noon = new Date(2026, 10, 1, 12, 30).getTime();
  assert.equal(startOfDay(noon), new Date(2026, 10, 1).getTime());
  assert.equal(TAG_WORD.merge, 'Ready to merge');
});

test('GitHub auto-merge or a landing label marks a PR as landing by itself', () => {
  const base = { statusCheckRollup: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  assert.equal(pullRequestDetails({ ...base })?.landing, undefined);
  assert.equal(pullRequestDetails({ ...base, autoMergeRequest: { enabledAt: 'x' } })?.landing, true);
  assert.equal(pullRequestDetails({ ...base, autoMergeRequest: null, labels: [{ name: 'merge-on-green' }] })?.landing, true);
  assert.equal(pullRequestDetails({ ...base, labels: [null, { name: 'bug' }, 'merge-on-green'] })?.landing, undefined);
  assert.ok(LANDING_LABELS.has('merge-on-green'));
});

test("the reader keeps a merged PR's merge time, and only a merged one's", async () => {
  const { createPullRequestReader } = await import('../src/lib/threadPullRequest.ts');
  const answers: Record<string, any> = {
    'https://github.com/o/r/pull/1': { state: 'MERGED', mergedAt: '2026-11-01T10:42:00Z' },
    'https://github.com/o/r/pull/2': { state: 'MERGED', mergedAt: 'not a date' },
    'https://github.com/o/r/pull/3': { state: 'OPEN', mergedAt: '2026-11-01T10:42:00Z' },
  };
  const read = createPullRequestReader({
    head: async () => null,
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    gh: async (link) => ({ ok: true, stdout: JSON.stringify(answers[link!]) }),
  });
  assert.equal((await read.status('https://github.com/o/r/pull/1')).mergedAt, Date.parse('2026-11-01T10:42:00Z'));
  assert.equal((await read.status('https://github.com/o/r/pull/2')).mergedAt, undefined);
  assert.equal((await read.status('https://github.com/o/r/pull/3')).mergedAt, undefined);
});
