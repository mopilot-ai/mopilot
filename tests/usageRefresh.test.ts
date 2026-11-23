// When an account's usage is read again (electron/identity/contract/usageRefresh.cjs): tiers by activity, overlap, backoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { UsageRefresh, usageReason, MAX_AGE, RECENT_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS } = createRequire(import.meta.url)(
  '../electron/identity/contract/usageRefresh.cjs',
);
const MIN = 60_000;

function clocked() {
  const clock = { t: 1_000_000_000 };
  const policy = new UsageRefresh({ now: () => clock.t });
  let reads = 0;
  const read =
    (r: any = {}) =>
    async () => (reads++, { measuredAt: clock.t, ...r });
  return { clock, policy, read, reads: () => reads };
}

test('a timer reads the login in use every 5 min and an idle one hourly; a surface opening, after 1 and 15 min', async () => {
  const { clock, policy, read, reads } = clocked();
  for (const id of ['active', 'idle']) await policy.refresh(id, { reason: 'now', hot: false }, read());
  assert.equal(reads(), 2);
  const tick = (id: string, reason: string) => policy.refresh(id, { reason, hot: policy.hot(id, 'active') }, read());
  clock.t += 4 * MIN;
  assert.deepEqual(await tick('active', 'background'), { read: false, retryAt: null });
  assert.equal((await tick('active', 'surface')).read, true, 'a surface opening reads the active login after a minute');
  clock.t += 5 * MIN;
  assert.equal((await tick('active', 'background')).read, true);
  assert.equal((await tick('idle', 'background')).read, false, 'an idle login is not read by the timer within the hour');
  clock.t += 6 * MIN;
  assert.equal((await tick('idle', 'surface')).read, true, 'a surface opening reads an idle login after 15 min');
  clock.t += 59 * MIN;
  assert.equal((await tick('idle', 'background')).read, false);
  clock.t += MIN;
  assert.equal((await tick('idle', 'background')).read, true);
  assert.equal(reads(), 6);
  assert.deepEqual(MAX_AGE.background, { hot: 5 * MIN, idle: 60 * MIN });
});

test('a login used lately is read like the one in use, until it has been idle for a while', async () => {
  const { clock, policy } = clocked();
  assert.equal(policy.hot('b', 'a'), false);
  policy.used('b');
  assert.equal(policy.hot('b', 'a'), true);
  clock.t += RECENT_MS - 1;
  assert.equal(policy.hot('b', 'a'), true);
  clock.t += 1;
  assert.equal(policy.hot('b', 'a'), false);
  assert.equal(policy.hot('a', 'a'), true);
});

test('figures the caller already holds count as known, and so does a read that failed', async () => {
  const { clock, policy, read, reads } = clocked();
  assert.equal((await policy.refresh('a', { reason: 'background', hot: false, measuredAt: clock.t - 10 * MIN }, read())).read, false);
  assert.equal(reads(), 0);
  // the caller's own limit replaces the trigger's
  assert.equal(
    (await policy.refresh('a', { reason: 'background', hot: false, maxAge: 5 * MIN, measuredAt: clock.t - 10 * MIN }, read())).read,
    true,
  );
  assert.equal(reads(), 1);
});

test('overlapping refreshes of one account share one read and its failure; other accounts read independently', async () => {
  const { policy } = clocked();
  let release!: () => void;
  let calls = 0;
  const slow = () => {
    calls++;
    return new Promise<{ measuredAt: number }>((r) => (release = () => r({ measuredAt: 1 })));
  };
  const first = policy.refresh('a', { reason: 'background', hot: true }, slow);
  const second = policy.refresh('a', { reason: 'now', hot: true }, slow);
  assert.equal(second, first);
  const other = policy.refresh('b', { reason: 'now', hot: false }, async () => ({ measuredAt: 1 }));
  assert.deepEqual(await other, { read: true, retryAt: null });
  await Promise.resolve();
  release();
  assert.deepEqual(await first, { read: true, retryAt: null });
  assert.equal(calls, 1);
  // settled: the next one may read again
  const failing = policy.refresh('a', { reason: 'now', hot: true }, async () => {
    throw new Error('429 Too Many Requests');
  });
  const sharing = policy.refresh('a', { reason: 'now', hot: true }, slow);
  await assert.rejects(failing, /429/);
  await assert.rejects(sharing, /429/);
  assert.equal(calls, 1);
});

test('a refused or failed read backs that account off, doubling to an hour, without holding up other accounts', async () => {
  const { clock, policy, read, reads } = clocked();
  const t0 = clock.t;
  assert.deepEqual(await policy.refresh('a', { reason: 'now', hot: true }, read({ refused: true })), {
    read: true,
    retryAt: t0 + BACKOFF_BASE_MS,
  });
  assert.equal(policy.retryAt('a'), t0 + BACKOFF_BASE_MS);
  // even "now" waits for the backoff; another account does not
  assert.deepEqual(await policy.refresh('a', { reason: 'now', hot: true }, read()), { read: false, retryAt: t0 + BACKOFF_BASE_MS });
  assert.equal((await policy.refresh('b', { reason: 'now', hot: true }, read())).read, true);
  assert.equal(policy.retryAt('b'), null);
  clock.t = t0 + BACKOFF_BASE_MS;
  await assert.rejects(
    policy.refresh('a', { reason: 'now', hot: true }, async () => {
      throw new Error('timed out');
    }),
    /timed out/,
  );
  assert.equal(policy.retryAt('a'), clock.t + 2 * BACKOFF_BASE_MS);
  for (let i = 0; i < 8; i++) {
    clock.t = policy.retryAt('a');
    await policy.refresh('a', { reason: 'now', hot: true }, read({ refused: true }));
  }
  assert.equal(policy.retryAt('a'), clock.t + BACKOFF_MAX_MS);
  // a fresh reading ends the backoff
  clock.t = policy.retryAt('a');
  assert.deepEqual(await policy.refresh('a', { reason: 'now', hot: true }, read()), { read: true, retryAt: null });
  assert.equal(reads(), 11);
});

test('a new sign-in clears the backoff, and a forgotten account starts over', async () => {
  const { policy, read, reads } = clocked();
  await policy.refresh('a', { reason: 'now', hot: true }, read({ refused: true }));
  assert.notEqual(policy.retryAt('a'), null);
  policy.clear('a');
  assert.equal(policy.retryAt('a'), null);
  assert.equal((await policy.refresh('a', { reason: 'background', hot: false }, read())).read, true, 'a cleared account is due at once');
  policy.used('a');
  policy.forget('a');
  assert.equal(policy.hot('a', null), false);
  policy.clear('never-seen');
  assert.equal(policy.retryAt('never-seen'), null);
  assert.equal((await policy.refresh('a', { reason: 'background', hot: false }, read())).read, true);
  assert.equal(reads(), 3);
});

test('a read that measured nothing (or an older figure) keeps the newest measurement', async () => {
  const { clock, policy } = clocked();
  await policy.refresh('a', { reason: 'now', hot: false }, async () => ({ measuredAt: clock.t }));
  clock.t += 20 * MIN;
  await policy.refresh('a', { reason: 'surface', hot: false }, async () => undefined);
  await policy.refresh('a', { reason: 'now', hot: false }, async () => ({ measuredAt: 5 }));
  clock.t += 14 * MIN;
  assert.equal((await policy.refresh('a', { reason: 'surface', hot: false }, async () => undefined)).read, false);
});

test('an IPC reason is one of the known triggers, else a surface opening', () => {
  assert.equal(usageReason('background'), 'background');
  assert.equal(usageReason('now'), 'now');
  assert.equal(usageReason('toString'), 'surface');
  assert.equal(usageReason(undefined), 'surface');
  assert.equal(usageReason(0), 'surface');
});

test('a policy without a clock uses the wall clock', async () => {
  const policy = new UsageRefresh();
  policy.used('a');
  assert.equal(policy.hot('a', null), true);
});

test("a live turn's figures count as a reading: the timer's next read waits from them", async () => {
  const { clock, policy, read, reads } = clocked();
  await policy.refresh('a', { reason: 'now', hot: true }, read());
  clock.t += 4 * MIN;
  policy.noteLive('a', clock.t);
  clock.t += 4 * MIN;
  assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, false, '4 min after the live reading');
  clock.t += MIN;
  assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, true);
  // an older live reading never moves the measurement back
  policy.noteLive('a', clock.t - 30 * MIN);
  assert.equal((await policy.refresh('a', { reason: 'surface', hot: true }, read())).read, false);
  assert.equal(reads(), 2);
});

test('a limit moves the timed read to the reset: none before it, one right at it whatever the tier or a backoff says', async () => {
  const { clock, policy, read, reads } = clocked();
  const resetsAt = clock.t + 3 * 60 * MIN;
  policy.limited('a', resetsAt);
  for (let t = 0; t < 3 * 60; t += 5) {
    assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, false);
    clock.t += 5 * MIN;
  }
  assert.equal(reads(), 0, 'nothing a timer reads before the reset can be news');
  // a surface opening or the user still reads by the usual rules while the account waits for its reset
  clock.t = resetsAt - 10 * MIN;
  assert.equal((await policy.refresh('a', { reason: 'surface', hot: true }, read())).read, true);
  // a refused read backs it off past the reset; the reset is read all the same
  clock.t = resetsAt - MIN;
  await policy.refresh('a', { reason: 'now', hot: true }, read({ refused: true }));
  assert.ok((policy.retryAt('a') ?? 0) > resetsAt);
  clock.t = resetsAt;
  assert.deepEqual(await policy.refresh('a', { reason: 'background', hot: false }, read()), { read: true, retryAt: null });
  assert.equal(reads(), 3);
  // that read was the one the reset waited for: the timer is back on its tier
  clock.t += MIN;
  assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, false);
});

test('a limit with no known reset is read at the next tick; a known reset is kept; a live reading after the reset replaces the read', async () => {
  const { clock, policy, read, reads } = clocked();
  await policy.refresh('a', { reason: 'now', hot: true }, read());
  policy.limited('a', null);
  assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, true, 'learns the reset');
  // the refusal is followed by an error with no reset: the reset already known stands
  policy.limited('a', clock.t + 60 * MIN);
  policy.limited('a', null);
  policy.limited('a', clock.t - 1);
  clock.t += 59 * MIN;
  assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, false);
  clock.t += MIN;
  policy.noteLive('a', clock.t);
  assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, false, 'a turn already said');
  assert.equal(reads(), 2);
  // a new sign-in drops the hold with the rest
  policy.limited('b', clock.t + 60 * MIN);
  policy.clear('b');
  assert.equal((await policy.refresh('b', { reason: 'background', hot: true }, read())).read, true);
});

test('a limit with no known reset waits out a backoff: a refusing source is not asked again for it', async () => {
  const { clock, policy, read, reads } = clocked();
  await policy.refresh('a', { reason: 'now', hot: true }, read({ refused: true }));
  const until = policy.retryAt('a')!;
  policy.limited('a', null);
  clock.t = until - 1;
  assert.deepEqual(await policy.refresh('a', { reason: 'background', hot: true }, read()), { read: false, retryAt: until });
  clock.t = until;
  assert.equal((await policy.refresh('a', { reason: 'background', hot: true }, read())).read, true);
  assert.equal(reads(), 2);
});
