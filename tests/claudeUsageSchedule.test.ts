// Claude Code usage on main's schedule (electron/harness/claude/usageSchedule.cjs): which logins are read, when, and what a
// caller gets back when no read runs. The CLI is a stub; the clock is the test's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { createUsageSchedule, CACHED_ANSWER_MS } = req('../electron/harness/claude/usageSchedule.cjs');
const { UsageRefresh } = req('../electron/identity/contract/usageRefresh.cjs');
const MIN = 60_000;

function schedule(o: { active?: string; fetched?: (id: string) => number | null } = {}) {
  const clock = { t: 1_000_000_000 };
  const reads: string[] = [];
  const s = createUsageSchedule({
    read: async (_bin: string, account: string | undefined) => (
      reads.push(String(account)), `Current session: 1% used (usage of ${account})`
    ),
    measuredAt: o.fetched ?? (() => clock.t),
    configIdOf: (account: string | undefined) => account ?? 'cur',
    active: () => o.active ?? 'cur',
    policy: new UsageRefresh({ now: () => clock.t }),
    now: () => clock.t,
  });
  return { s, clock, reads };
}

test('the login in use is read by the timer every 5 min, an idle one hourly, and one a turn ran on as often as the one in use', async () => {
  const { s, clock, reads } = schedule();
  for (const id of ['cur', 'idle', 'busy']) await s.usage('bin', id, 'now');
  reads.length = 0;
  s.used('busy');
  clock.t += 5 * MIN;
  for (const id of ['cur', 'idle', 'busy']) await s.usage('bin', id, 'background');
  assert.deepEqual(reads, ['cur', 'busy']);
  // no account named: the login in use
  clock.t += 5 * MIN;
  assert.equal((await s.usage('bin', undefined, 'background')).text, 'Current session: 1% used (usage of cur)');
  assert.deepEqual(reads, ['cur', 'busy', 'cur']);
});

test('an answer the CLI measured well before it was asked came from its cache: the login backs off; a recent one does not', async () => {
  let fetched = 0;
  const { s, clock } = schedule({ fetched: () => fetched });
  fetched = clock.t - CACHED_ANSWER_MS;
  assert.equal((await s.usage('bin', 'a', 'now')).retryAt, undefined, 'measured at the edge: still a fresh answer');
  fetched = clock.t - CACHED_ANSWER_MS - 1;
  const r = await s.usage('bin', 'b', 'now');
  assert.equal(r.measuredAt, fetched);
  assert.ok(r.retryAt > clock.t);
});

test('a login that reads signed in again is read at once, its earlier failure forgotten', async () => {
  const { s, reads } = schedule({
    fetched: () => 1,
  });
  await s.usage('bin', 'a', 'now');
  assert.equal((await s.usage('bin', 'a', 'now')).cached, true);
  s.clear('a');
  const r = await s.usage('bin', 'a', 'background');
  assert.equal(r.cached, false);
  assert.deepEqual(reads, ['a', 'a']);
});

test('a policy that answers without a read for a login never read says so instead of inventing figures', async () => {
  const s = createUsageSchedule({
    read: async () => 'unused',
    measuredAt: () => null,
    configIdOf: (a: string) => a,
    active: () => 'a',
    policy: { capture: () => () => true, refresh: async () => ({ read: false, retryAt: null }), hot: () => true, retryAt: () => null },
  });
  assert.deepEqual(await s.usage('bin', 'a', 'surface'), {
    state: 'error',
    error: 'Claude Code usage has not been read yet.',
    account: null,
    cached: true,
  });
});

test('without a clock or policy of its own it uses the wall clock and a fresh policy', async () => {
  const s = createUsageSchedule({
    read: async () => 'text',
    measuredAt: () => null,
    configIdOf: (a: string) => a,
    active: () => 'a',
  });
  const before = Date.now();
  const r = await s.usage('bin', 'a');
  assert.equal(r.state, 'success');
  assert.ok(r.measuredAt >= before);
});

test("a login that signs in again while a key runs the harness clears its own backoff, not the key folder's", async () => {
  const clock = { t: 1_000_000_000 };
  const policy = new UsageRefresh({ now: () => clock.t });
  const s = createUsageSchedule({
    read: async () => {
      throw new Error('429 Too Many Requests');
    },
    measuredAt: () => null,
    configIdOf: () => 'key-apiKey',
    active: () => 'a',
    policy,
    now: () => clock.t,
  });
  await s.usage('bin', 'a', 'now');
  await policy.refresh('a', { reason: 'now', hot: true }, async () => ({ refused: true }));
  s.clear('a');
  assert.notEqual(policy.retryAt('key-apiKey'), null);
  assert.equal(policy.retryAt('a'), null);
  s.used('b');
  assert.equal(policy.hot('b', 'x'), true);
});

test('an answer with no figures (the usage endpoint refused and nothing was cached) backs the login off (#1582)', async () => {
  const clock = { t: 1_000_000_000 };
  const s = createUsageSchedule({
    read: async () => 'You are currently using your subscription to power your Claude Code usage\n\nWhat is contributing…',
    measuredAt: () => null,
    configIdOf: (a: string) => a,
    active: () => 'a',
    policy: new UsageRefresh({ now: () => clock.t }),
    now: () => clock.t,
  });
  const r = await s.usage('bin', 'a', 'now');
  assert.equal(r.state, 'success');
  assert.ok(r.retryAt > clock.t, 'backing off');
  assert.equal((await s.usage('bin', 'a', 'surface')).cached, true);
});

test('an answer names the server account its login is, and a key folder names none (#1582)', async () => {
  const s = createUsageSchedule({
    read: async () => 'Current session: 1% used',
    measuredAt: () => null,
    configIdOf: (a: string | undefined) => (a === 'k' ? 'key-apiKey' : (a ?? 'a')),
    active: () => 'a',
    accountOf: (login: string) => (login === 'a' ? 'uuid-a' : null),
  });
  assert.equal((await s.usage('bin', 'a', 'now')).account, 'uuid-a');
  assert.equal((await s.usage('bin', undefined, 'now')).account, 'uuid-a');
  assert.equal((await s.usage('bin', 'b', 'now')).account, null, 'not known');
  assert.equal((await s.usage('bin', 'k', 'now')).account, null, "a key's folder is no login's account");
  // a failed read names the account too, so its failure is the right account's
  const failing = createUsageSchedule({
    read: async () => {
      throw new Error('boom');
    },
    measuredAt: () => null,
    configIdOf: (a: string | undefined) => a ?? 'a',
    active: () => 'a',
    accountOf: () => 'uuid-a',
  });
  const f = await failing.usage('bin', 'a', 'now');
  assert.deepEqual([f.state, f.account], ['error', 'uuid-a']);
});

test('an answer kept from before a sign-in as another account names the account it was read as (#1582)', async () => {
  const clock = { t: 1_000_000_000 };
  let who = 'uuid-a';
  const s = createUsageSchedule({
    read: async () => `Current session: 1% used (of ${who})`,
    measuredAt: () => clock.t,
    configIdOf: (a: string | undefined) => a ?? 'x',
    active: () => 'x',
    accountOf: () => who,
    policy: new UsageRefresh({ now: () => clock.t }),
    now: () => clock.t,
  });
  assert.equal((await s.usage('bin', 'x', 'now')).account, 'uuid-a');
  // signed in again as b: until a read runs, the answer kept is still a's, and says so
  who = 'uuid-b';
  const kept = await s.usage('bin', 'x', 'surface');
  assert.deepEqual([kept.cached, kept.account, kept.text], [true, 'uuid-a', 'Current session: 1% used (of uuid-a)']);
  // a new sign-in clears what held the login back: the next read is b's
  s.clear('x');
  assert.equal((await s.usage('bin', 'x', 'surface')).account, 'uuid-b');
});

test('headings without a percent used are no figures either (#1582)', async () => {
  const s = createUsageSchedule({
    read: async () => 'Current week (all models)\n████████',
    measuredAt: () => null,
    configIdOf: (a: string) => a,
    active: () => 'a',
  });
  assert.ok((await s.usage('bin', 'a', 'now')).retryAt);
});
