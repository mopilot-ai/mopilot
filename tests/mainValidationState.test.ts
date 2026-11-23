// Main validation ownership, bounded retries and shared CLI/web freshness decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairedGreen,
  statusesGreen,
  suitePlan,
  freshness,
  parseSnapshot,
  runView,
  parseRuns,
  parseJobs,
  MAIN_QUERY,
  SCOPED_MARK,
  fullE2eDue,
  isScoped,
  retryExclusions,
  JOB_TIMEOUT_MINUTES,
} from '../shared/mainValidation.ts';
import { mainCommit, mainGraph } from './support/main-validation-fixtures.ts';
import { contexts as posted } from './support/ciStatuses.ts';

const NOW = Date.parse('2026-10-20T04:00:00Z');
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const both = [
  { context: 'main-unit-tests', state: 'success' },
  { context: 'main-e2e', state: 'success' },
];
const commit = (sha: string, minutes: number, statuses = both) => ({ sha, date: at(minutes), message: sha, statuses });

test('a green commit needs the newest result of both suites on that commit', () => {
  assert.equal(pairedGreen(both), true);
  assert.equal(pairedGreen([]), false);
  assert.equal(pairedGreen([both[0]]), false);
  assert.equal(pairedGreen([{ ...both[1], state: 'pending' }, ...both]), false);
  assert.equal(pairedGreen([{ ...both[0], state: 'failure' }, ...both]), false);
});

test("the shared release decision uses the caller's required contexts and never an obsolete success", () => {
  const statuses = [
    { context: 'first', state: 'success' },
    { context: 'second', state: 'pending' },
  ];
  assert.equal(statusesGreen(statuses, ['first']), true);
  assert.equal(statusesGreen(statuses, ['first', 'second']), false);
  assert.equal(statusesGreen(statuses, ['missing']), false);
  assert.equal(statusesGreen([{ context: 'first', state: 'pending' }, ...statuses], ['first']), false);
});

test('suite planning preserves success and permits at most one automatic retry of a failed or missing result', () => {
  assert.deepEqual(suitePlan([]), { unit: true, e2e: true, retryUnit: true, retryE2e: true });
  assert.deepEqual(suitePlan(both), { unit: false, e2e: false, retryUnit: false, retryE2e: false });
  const failure = { context: 'main-e2e', state: 'failure' };
  assert.deepEqual(suitePlan([failure, both[0]]), { unit: false, e2e: true, retryUnit: false, retryE2e: false });
  assert.equal(suitePlan([failure, { ...failure, state: 'error' }]).e2e, false);
  assert.equal(suitePlan([{ ...failure, state: 'pending' }, failure]).e2e, true);
});

test('freshness measures waiting changes rather than the age of a quiet green commit', () => {
  assert.deepEqual(freshness([commit('a', 500)], NOW), { head: 'a', tested: 'a', behind: 0, lagMinutes: 0, overdue: false });
  assert.deepEqual(freshness([commit('c', 1, []), commit('b', 29, []), commit('a', 500)], NOW), {
    head: 'c',
    tested: 'a',
    behind: 2,
    lagMinutes: 29,
    overdue: false,
  });
  const overdue = freshness([commit('c', 1, []), commit('b', 30, []), commit('a', 500)], NOW);
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.lagMinutes, 30);
  assert.deepEqual(freshness([commit('a', 40, [])], NOW), { head: 'a', tested: null, behind: null, lagMinutes: 40, overdue: true });
  assert.throws(() => freshness([], NOW), /main|snapshot/i);
});

test('GraphQL snapshots follow first parents and reject incomplete or malformed external data', () => {
  const node = (sha: string, parent: string, contexts: unknown = posted(both.map((s) => ({ ...s, state: s.state.toUpperCase() })))) => ({
    oid: sha,
    committedDate: at(5),
    messageHeadline: sha,
    parents: { nodes: parent ? [{ oid: parent }] : [] },
    status: contexts === null ? null : { contexts },
  });
  const graph = (nodes: unknown) => ({ data: { repository: { ref: { target: { history: { nodes } } } } } });
  assert.match(MAIN_QUERY, /refs\/heads\/main/);
  const parsed = parseSnapshot(graph([node('c', 'a', null), node('branch', ''), node('a', '')]));
  assert.deepEqual(
    parsed.map((c) => c.sha),
    ['c', 'a'],
  );
  assert.deepEqual(parsed[0].statuses, []);
  assert.equal(pairedGreen(parsed[1].statuses), true);
  for (const bad of [
    null,
    {},
    graph([]),
    graph([null]),
    graph([1]),
    graph([[]]),
    graph([{}]),
    graph([node('c', '', {})]),
    graph([node('c', '', [{ context: 1, state: 'SUCCESS' }])]),
  ]) {
    assert.throws(() => parseSnapshot(bad), /snapshot|GitHub/i);
  }
  const broken = node('c', '');
  broken.committedDate = 'invalid';
  assert.throws(() => parseSnapshot(graph([broken])), /snapshot|GitHub/i);
});

test('run presentation separates runner queues, execution, deadline breaches and terminal outcomes', () => {
  const base = { id: 1, status: 'queued', conclusion: null, createdAt: at(2), url: 'https://github.com/o/r/actions/runs/1' };
  assert.deepEqual(runView(base, [], NOW), { state: 'queued', minutes: 2, detail: 'Waiting for a runner', delayed: false, url: base.url });
  assert.equal(runView({ ...base, createdAt: at(10) }, [], NOW).delayed, true);
  const jobs = [{ name: 'unit / test', status: 'in_progress', startedAt: at(4) }];
  assert.deepEqual(runView({ ...base, status: 'in_progress' }, jobs, NOW), {
    state: 'running',
    minutes: 4,
    detail: 'unit / test',
    delayed: false,
    url: base.url,
  });
  assert.equal(runView({ ...base, status: 'in_progress' }, [{ ...jobs[0], startedAt: at(JOB_TIMEOUT_MINUTES) }], NOW).state, 'stalled');
  assert.equal(runView({ ...base, status: 'completed', conclusion: 'success' }, [], NOW).state, 'passed');
  assert.equal(runView({ ...base, status: 'completed', conclusion: 'cancelled' }, [], NOW).state, 'cancelled');
  assert.equal(runView({ ...base, status: 'completed', conclusion: 'failure' }, [], NOW).state, 'failed');
  assert.equal(runView({ ...base, status: 'in_progress' }, [], NOW).state, 'queued');
});

test('run and job boundary guards reject malformed identities, dates, states and truncated job pages', () => {
  const run = { id: 1, status: 'in_progress', conclusion: null, created_at: at(2), html_url: 'https://github.com/o/rel/actions/runs/1' };
  assert.equal(parseRuns({ workflow_runs: [run] })[0].id, 1);
  for (const bad of [
    null,
    1,
    { ...run, id: 1.5 },
    { ...run, id: 0 },
    { ...run, status: 'unknown' },
    { ...run, conclusion: 1 },
    { ...run, html_url: null },
    { ...run, created_at: null },
    { ...run, created_at: 'invalid' },
  ]) {
    assert.throws(() => parseRuns({ workflow_runs: [bad] }), /runs/);
  }
  assert.throws(() => parseRuns(null), /runs/);
  const job = { name: 'test', status: 'in_progress', started_at: at(1) };
  assert.equal(parseJobs({ jobs: [job] })[0].startedAt, at(1));
  assert.deepEqual(parseJobs({ jobs: [{ name: 'test', status: 'queued' }] })[0], { name: 'test', status: 'queued', startedAt: '' });
  for (const bad of [
    null,
    { ...job, name: 1 },
    { ...job, status: 'unknown' },
    { ...job, started_at: null },
    { ...job, started_at: 'invalid' },
  ])
    assert.throws(() => parseJobs({ jobs: [bad] }), /jobs/);
  assert.throws(() => parseJobs(null), /jobs/);
  assert.throws(() => parseJobs({ jobs: Array(100).fill(job) }), /jobs/);
});

test('a scoped main-e2e result says so in its description; any other is a full run', () => {
  assert.equal(SCOPED_MARK, '(scoped:');
  assert.equal(isScoped('The end-to-end suite passed (scoped: 3 specs reached by the changes since abc)'), true);
  assert.equal(isScoped('The end-to-end suite passed'), false);
  assert.equal(isScoped(''), false);
  assert.equal(isScoped(undefined), false);
});

// 2026-10-20 at 09:30 UTC, and a main-e2e result n hours earlier
const NIGHT = Date.parse('2026-10-20T09:30:00Z');
const hoursAgo = (hours: number) => new Date(NIGHT - hours * 3_600_000).toISOString();
const e2e = (hours: number, over: object = {}) => ({
  context: 'main-e2e',
  state: 'success',
  description: 'The end-to-end suite passed',
  updated_at: hoursAgo(hours),
  ...over,
});

test("the night's full E2E run is due after 09:00 UTC unless a full run passed in the last 20 hours", () => {
  const history = (...statuses: object[]) => [
    commit('a', 1, [{ context: 'main-unit-tests', state: 'success' }]),
    commit('b', 90, statuses as never),
  ];
  // nothing passed, or only a scoped pass, a failure, another context or an old full pass
  assert.equal(fullE2eDue(history(), NIGHT), true);
  assert.equal(
    fullE2eDue(history(e2e(1, { description: 'The end-to-end suite passed (scoped: 2 specs reached by the changes since abc)' })), NIGHT),
    true,
  );
  assert.equal(fullE2eDue(history(e2e(1, { state: 'failure' }), e2e(30, { state: 'pending' })), NIGHT), true);
  assert.equal(fullE2eDue(history(e2e(1, { context: 'main-unit-tests' })), NIGHT), true);
  assert.equal(fullE2eDue(history(e2e(20)), NIGHT), true);
  assert.equal(fullE2eDue(history(e2e(5, { updated_at: undefined })), NIGHT), true);
  // a full pass 19 hours ago (any commit of the snapshot) holds it off, with a scoped pass newer than it
  assert.equal(fullE2eDue(history(e2e(19)), NIGHT), false);
  assert.equal(fullE2eDue(history(e2e(1, { description: 'x (scoped: no spec reaches the changes since a)' }), e2e(19)), NIGHT), false);
  // not before 09:00 UTC, whatever passed
  assert.equal(fullE2eDue(history(), Date.parse('2026-10-20T08:59:00Z')), false);
  assert.equal(fullE2eDue(history()), new Date().getUTCHours() >= 9);
});

test('the snapshot carries each status description, which tells a scoped pass from a full one', () => {
  assert.match(MAIN_QUERY, /context state description targetUrl createdAt/);
  const statuses = [
    { context: 'main-e2e', state: 'success', description: 'The end-to-end suite passed', updated_at: '2026-10-20T03:00:00Z' },
    { context: 'main-unit-tests', state: 'success' },
  ];
  const [parsed] = parseSnapshot(mainGraph([mainCommit('a'.repeat(40), 1, statuses as never)]));
  assert.equal(parsed.statuses[0].description, 'The end-to-end suite passed');
  assert.equal('description' in parsed.statuses[1], false);
});

test('the E2E retry skips the shards a scoped first try passed, however few it ran', () => {
  const job = (n: number, conclusion: string | null, scope = 'e2e') => ({ name: `${scope} / e2e (${n})`, conclusion });
  // two shards ran and one failed; the other is skipped
  assert.deepEqual(retryExclusions([job(1, 'success'), job(2, 'failure')]), [{ shard: 1 }]);
  // both passed (the report or the scope job failed instead): the retry tests both, not none
  assert.deepEqual(retryExclusions([job(1, 'success'), job(2, 'success')]), []);
  // one shard ran and failed
  assert.deepEqual(retryExclusions([job(1, 'failure')]), []);
  // a name that is not a shard of this scope is not a shard
  assert.deepEqual(
    retryExclusions([
      job(1, 'success', 'unit'),
      { name: 'e2e / e2e (x)', conclusion: 'success' },
      { name: 'e2e / e2e (2) extra', conclusion: 'success' },
    ]),
    [],
  );
});
