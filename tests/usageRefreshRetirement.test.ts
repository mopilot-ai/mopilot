// Sign-in and removal retire pending quota reads, their backoff, cached answers and renderer continuations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { controlledReads, tick } from './support/async-scenarios.ts';
import { createUsageRefresher } from '../src/harness/claudeUsage.ts';

const req = createRequire(import.meta.url);
const { UsageRefresh, BACKOFF_BASE_MS } = req('../electron/identity/contract/usageRefresh.cjs');
const { createUsageSchedule } = req('../electron/harness/claude/usageSchedule.cjs');
const NOW = 1_000_000_000;

for (const result of ['success', 'refused', 'error'] as const) {
  test(`a sign-in retires an in-flight ${result} without blocking the replacement or deleting its request`, async () => {
    const policy = new UsageRefresh({ now: () => NOW });
    const reads = controlledReads<any>();
    const old = policy.refresh('a', { reason: 'now', hot: true }, reads.read);
    await tick();
    policy.used('a');
    policy.clear('a');
    assert.equal(policy.hot('a', 'b'), true, 'sign-in preserves recent use');
    const fresh = policy.refresh('a', { reason: 'now', hot: true }, reads.read);
    await tick();
    assert.equal(reads.requests.length, 2);
    if (result === 'error') reads.requests[0].reject(new Error('old failure'));
    else reads.requests[0].resolve({ measuredAt: NOW, refused: result === 'refused' });
    assert.deepEqual(await old, { read: false, retryAt: null });
    assert.equal(policy.retryAt('a'), null);
    assert.equal(policy.refresh('a', { reason: 'now', hot: true }, reads.read), fresh, 'old cleanup keeps replacement');
    reads.requests[1].resolve({ measuredAt: NOW });
    assert.deepEqual(await fresh, { read: true, retryAt: null });
  });
}

test('a retired queued read never starts; repeated sign-ins and forgetting preserve only the newest owner', async () => {
  const policy = new UsageRefresh({ now: () => NOW });
  const reads = controlledReads<any>();
  const old = policy.refresh('a', { reason: 'now', hot: true }, reads.read);
  policy.clear('a');
  const middle = policy.refresh('a', { reason: 'now', hot: true }, reads.read);
  policy.forget('a');
  const fresh = policy.refresh('a', { reason: 'now', hot: true }, reads.read);
  await tick();
  assert.equal(reads.requests.length, 1);
  reads.requests[0].resolve({ refused: true });
  await Promise.all([old, middle, fresh]);
  assert.equal(policy.retryAt('a'), NOW + BACKOFF_BASE_MS, 'fresh refusal still backs off');
  assert.equal((await policy.refresh('a', { reason: 'now', hot: true }, reads.read)).read, false);
  assert.equal((await policy.refresh('b', { reason: 'now', hot: true }, async () => ({}))).read, true);
});

for (const retire of ['clear', 'forget'] as const) {
  for (const fail of [false, true]) {
    test(`Claude ${retire} ignores a late ${fail ? 'error' : 'success'} after the replacement answer`, async () => {
      const reads = controlledReads<string>();
      let who = 'old';
      const s = createUsageSchedule({
        read: reads.read,
        measuredAt: () => NOW,
        configIdOf: (id: string) => id,
        active: () => 'a',
        accountOf: () => who,
        policy: new UsageRefresh({ now: () => NOW }),
        now: () => NOW,
      });
      const old = s.usage('fake-bin', 'a', 'now');
      await tick();
      s[retire]('a');
      who = 'new';
      const fresh = s.usage('fake-bin', 'a', 'now');
      await tick();
      assert.equal(reads.requests.length, 2);
      reads.requests[1].resolve('Current week: 7% used');
      const answer = await fresh;
      assert.equal(answer.account, 'new');
      if (fail) reads.requests[0].reject(new Error('old login failed'));
      else reads.requests[0].resolve('Current week: 99% used');
      await old;
      assert.deepEqual(await s.usage('fake-bin', 'a', 'surface'), { ...answer, cached: true });
    });
  }
}

for (const reason of ['now', 'surface'] as const) {
  test(`renderer invalidation retires ${reason} reads, queued promotions and old finalizers`, async () => {
    const reads = controlledReads<any>();
    const notes: any[] = [];
    const refresh = createUsageRefresher({
      read: reads.read,
      current: () => null,
      noteReading: (...args) => notes.push(args),
      noteFetch: () => {},
    });
    const old = refresh('a', reason);
    const queued = refresh('a', 'now');
    await tick();
    refresh.invalidate('a');
    const fresh = refresh('a', 'now');
    await tick();
    assert.equal(reads.requests.length, 2);
    reads.requests[0].resolve({ state: 'success', text: 'Current week: 99% used', measuredAt: NOW, account: 'old' });
    await Promise.all([old, queued]);
    assert.equal(notes.length, 0);
    assert.equal(refresh('a', 'now'), fresh);
    assert.equal(reads.requests.length, 2, 'retired queued promotion starts no new request');
    reads.requests[1].resolve({ state: 'success', text: 'Current week: 7% used', measuredAt: NOW, account: 'new' });
    await fresh;
    assert.equal(notes.length, 1);
    assert.equal(notes[0][1].account, 'new');
  });
}

test('another window ignores a retired main answer even when only the initiating window invalidated locally', async () => {
  const reads = controlledReads<string>();
  const s = createUsageSchedule({
    read: reads.read,
    measuredAt: () => NOW,
    configIdOf: (id: string) => id,
    active: () => 'a',
    policy: new UsageRefresh({ now: () => NOW }),
    now: () => NOW,
  });
  const notes: any[] = [];
  const window = () =>
    createUsageRefresher({
      read: (id, reason) => s.usage('fake-bin', id, reason),
      current: () => null,
      noteReading: (...args) => notes.push(args),
      noteFetch: (_id, state) => {
        if (state !== 'loading') notes.push(state);
      },
    });
  const elsewhere = window();
  const initiator = window();
  const old = elsewhere('a', 'now');
  await tick();
  s.clear('a');
  initiator.invalidate('a');
  const fresh = initiator('a', 'now');
  await tick();
  reads.requests[1].resolve('Current week: 7% used');
  await fresh;
  reads.requests[0].reject(new Error('old login failed'));
  await old;
  assert.equal(notes.length, 1);
  assert.equal(notes[0][1].windows[0].usedPercent, 7);
});

test('an omitted login is pinned before a queued read starts, even if the active login switches', async () => {
  let active = 'a';
  const seen: string[] = [];
  const s = createUsageSchedule({
    read: async (_bin: string, id: string) => (seen.push(id), 'Current week: 7% used'),
    measuredAt: () => NOW,
    configIdOf: (id: string) => id ?? active,
    active: () => active,
    accountOf: (id: string) => `server-${id}`,
    policy: new UsageRefresh({ now: () => NOW }),
    now: () => NOW,
  });
  const pending = s.usage('fake-bin', undefined, 'now');
  active = 'b';
  const answer = await pending;
  assert.deepEqual(seen, ['a']);
  assert.equal(answer.account, 'server-a');
});

test('invalidation after finalization still retires an already queued now promotion', async () => {
  const reads = controlledReads<any>();
  const refresh = createUsageRefresher({ read: reads.read, current: () => null, noteReading: () => {}, noteFetch: () => {} });
  const old = refresh('a', 'surface');
  await tick();
  const invalidate = old.then(() => refresh.invalidate('a'));
  const queued = refresh('a', 'now');
  reads.requests[0].resolve({ state: 'success', text: 'Current week: 1% used', measuredAt: NOW });
  await invalidate;
  await tick();
  const count = reads.requests.length;
  if (count > 1) reads.requests[1].resolve({ state: 'success', text: 'Current week: 2% used', measuredAt: NOW });
  await queued;
  assert.equal(count, 1);
});

test('renderer invalidation before its microtask skips the read and leaves another login independent', async () => {
  const seen: string[] = [];
  const refresh = createUsageRefresher({
    read: async (id) => (seen.push(id), { state: 'error', error: 'current failure' }),
    current: () => null,
    noteReading: () => {},
    noteFetch: () => {},
  });
  const retired = refresh('a');
  refresh.invalidate('a');
  await Promise.all([retired, refresh('b')]);
  assert.deepEqual(seen, ['b']);
});

test('a retired success cannot clear a replacement refusal cooldown', async () => {
  const policy = new UsageRefresh({ now: () => NOW });
  const reads = controlledReads<any>();
  const old = policy.refresh('a', { reason: 'now', hot: true }, reads.read);
  await tick();
  policy.clear('a');
  const fresh = policy.refresh('a', { reason: 'now', hot: true }, reads.read);
  await tick();
  reads.requests[1].resolve({ refused: true });
  await fresh;
  reads.requests[0].resolve({ measuredAt: NOW });
  await old;
  assert.equal(policy.retryAt('a'), NOW + BACKOFF_BASE_MS);
});

test('an old-token turn cannot postpone or force the new account usage schedule', async () => {
  let now = NOW;
  let who = 'old';
  let calls = 0;
  const s = createUsageSchedule({
    read: async () => (calls++, 'Current week: 7% used'),
    measuredAt: () => now,
    configIdOf: (id: string) => id,
    active: () => 'a',
    accountOf: () => who,
    policy: new UsageRefresh({ now: () => now }),
    now: () => now,
  });
  await s.usage('fake-bin', 'a', 'now');
  s.clear('a');
  who = 'new';
  await s.usage('fake-bin', 'a', 'now');
  s.limited('a', 'old');
  await s.usage('fake-bin', 'a', 'background');
  assert.equal(calls, 2, 'an old assistant refusal cannot force a poll of the new account');
  s.heard('a', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: (now + 3_600_000) / 1000 }, 'old');
  now += 5 * 60_000;
  await s.usage('fake-bin', 'a', 'background');
  assert.equal(calls, 3, 'an old reset cannot hold the new account');
  s.limited('a', 'new');
  await s.usage('fake-bin', 'a', 'background');
  assert.equal(calls, 4, 'the current account refusal still schedules a fresh read');
});
