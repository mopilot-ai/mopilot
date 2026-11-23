// What a Codex turn reports about its account's usage (#1317), through electron/identity/accounts/limits.cjs: the
// app-server's push, the backend's headers and a 429 at the limit mark the account that served the turn, the window
// that ran out reads full, and the account's next timed read waits for the reset. Events are the recorded shapes in
// tests/fixtures/live-usage-events.json; Codex is faked (tests/support/electron-accounts.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup, sub, flush } from './support/electron-accounts.ts';

const req = createRequire(import.meta.url);
const { Accounts, limitInfo } = req('../electron/identity/codexAccounts.cjs');
const { UsageRefresh } = req('../electron/identity/contract/usageRefresh.cjs');
const { codex: ev } = JSON.parse(fs.readFileSync(new URL('./fixtures/live-usage-events.json', import.meta.url), 'utf8'));
const MIN = 60_000;
const WEEK_RESET = 1792346400;
const FIVE_H_RESET = 1792249200;
const before = (reset: number, ms: number) => reset * 1000 - ms;

/** Accounts with only what usage needs; the policy and every stamp read the test's clock (t.mock.timers). */
function manager(t: any, rows: any[]) {
  t.mock.timers.enable({ apis: ['Date'], now: before(FIVE_H_RESET, 60 * MIN) });
  const a = Object.create(Accounts.prototype);
  a.state = { active: rows[0].id, accounts: rows };
  a.applied = rows[0].id;
  a.mainMode = 'managed';
  a.syncDefault = () => {};
  a.changed = () => {};
  a.changedSoon = () => {};
  a.failover = async () => {};
  a.view = () => a.state;
  a.usageRefresh = new UsageRefresh({ now: () => Date.now() });
  const reads: string[] = [];
  a.readUsage = async (row: any) => (
    reads.push(row.id), { rateLimits: { limitId: 'codex', primary: { usedPercent: 3, resetsAt: FIVE_H_RESET } } }
  );
  return { a, reads, at: (ms: number) => t.mock.timers.setTime(ms) };
}
const account = (id: string) => ({ id, kind: 'chatgpt', email: `${id}@example.test`, status: 'ok', limits: null });

test("the app-server's push at the limit marks the login it holds and holds its timed read until the reset", async (t) => {
  const { a, reads, at } = manager(t, [account('a'), account('b')]);
  a.usageRefresh.used('b');
  a.onAppServerUsage(ev.rateLimitsUpdatedReached.params.rateLimits);
  const l = a.get('a').limits;
  assert.deepEqual([l.reached, l.resetsAt, l.primary.usedPercent, l.secondary.usedPercent], [true, FIVE_H_RESET, 100, 64]);
  assert.equal(a.get('b').limits, null, 'another account is not the one the app-server holds');
  for (let m = 5; m < 60; m += 5) {
    at(before(FIVE_H_RESET, 60 * MIN - m * MIN));
    await a.refreshUsage(['a']);
  }
  assert.deepEqual(reads, [], 'no timed read of the limited account before its reset');
  at(FIVE_H_RESET * 1000);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, ['a']);
  // out with no reset in the push: read at the next tick, which learns it
  a.onAppServerUsage({ limitId: 'codex', primary: { usedPercent: 40 }, rateLimitReachedType: 'rate_limit_reached' });
  assert.deepEqual([a.get('a').limits.reached, a.get('a').limits.resetsAt], [true, null]);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, ['a', 'a']);
  // mid-switch the push is nobody's: nothing is marked or held
  a.applied = 'b';
  a.onAppServerUsage(ev.rateLimitsUpdatedReached.params.rateLimits);
  assert.equal(a.get('b').limits, null);
});

test('response headers at the limit hold the account that answered; headers below it are only a reading', async (t) => {
  const { a, reads, at } = manager(t, [account('a')]);
  a.noteUsageHeaders(a.get('a'), { 'x-codex-primary-used-percent': '40', 'x-codex-primary-reset-at': String(FIVE_H_RESET) });
  at(Date.now() + 4 * MIN);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, [], 'the headers are 4 min old: the timer waits from them');
  a.noteUsageHeaders(a.get('a'), ev.headersAtLimit);
  assert.deepEqual([a.get('a').limits.reached, a.get('a').limits.resetsAt], [true, WEEK_RESET]);
  at(FIVE_H_RESET * 1000 + 10 * MIN);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, [], 'the weekly window holds it past the 5h reset');
  at(WEEK_RESET * 1000);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, ['a']);
  // nothing to note when the headers carry no reading
  a.get('a').limits = null;
  a.noteLiveLimits(a.get('a'));
  assert.equal(a.usageRefresh.retryAt('a'), null);
});

test('a 429 at the limit marks the window that resets then as full, and a poll that started before cannot undo it', async (t) => {
  const { a, reads, at } = manager(t, [account('a')]);
  const row = a.get('a');
  row.limits = limitInfo({
    primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: FIVE_H_RESET },
    secondary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: WEEK_RESET },
  });
  let finish!: (r: any) => void;
  a.readUsage = (r: any) => (reads.push(r.id), new Promise((resolve) => (finish = resolve)));
  const pending = a.refreshUsage(['a'], 'now');
  await flush();
  // the relay passes the 429's resets_at (electron/identity/accounts/relay.cjs usageLimit, covered in relayCoverage.test.ts)
  a.markLimited(row, ev.usageLimit429.error.resets_at);
  finish({ rateLimits: { limitId: 'codex', secondary: { usedPercent: 97, resetsAt: WEEK_RESET } } });
  await pending;
  const l = row.limits;
  assert.deepEqual([l.reached, l.resetsAt, l.used, l.primary.usedPercent, l.secondary.usedPercent], [true, WEEK_RESET, 100, 31, 100]);
  at(WEEK_RESET * 1000 - MIN);
  a.readUsage = async (r: any) => (reads.push(r.id), null);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, ['a'], 'held until the weekly reset');
  at(WEEK_RESET * 1000);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, ['a', 'a']);
});

test('a refusal with no reset leaves the windows as they were and has the account read at the next tick', async (t) => {
  const { a, reads } = manager(t, [account('a')]);
  const row = a.get('a');
  await a.refreshUsage(['a'], 'now');
  a.markLimited(row);
  assert.deepEqual([row.limits.reached, row.limits.resetsAt, row.limits.used, row.limits.primary.usedPercent], [true, null, 3, 3]);
  // nothing known at all: no window to mark
  const bare: { id: string; limits: any } = { id: 'x', limits: null };
  a.markLimited(bare);
  assert.deepEqual([bare.limits.primary, bare.limits.secondary, bare.limits.used, bare.limits.resetsAt], [null, null, null, null]);
  await a.refreshUsage(['a']);
  assert.deepEqual(reads, ['a', 'a'], 'read at once, to learn the reset');
});

test('a turn the app-server ends at its usage limit has the login it started on read at the next tick', async (t) => {
  const { a } = setup(t, { state: { autoSwitch: false, accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  const reads: string[] = [];
  a.readUsage = async (row: any) => (reads.push(row.id), null);
  a.state.active = a.applied = 'b';
  await a.refreshUsage(['b'], 'now');
  a.onMainMessage({ method: 'turn/started', params: { threadId: 'thr_1', turn: { id: 'turn_1' } } });
  a.onMainMessage(ev.turnUsageLimit);
  await flush(20);
  assert.equal(a.get('b').limits.reached, true);
  await a.refreshUsage(['b']);
  assert.deepEqual(reads, ['b', 'b']);
});
