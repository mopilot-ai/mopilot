// What a Claude Code turn reports about its login's plan usage (#1317): the rate_limit_event shapes the CLI sends
// (shared/claudeRateLimit.mjs), the reading main keeps for the login next to its polled /usage answer
// (electron/harness/claude/usageSchedule.cjs), and how a window merges it with a poll by when each was measured
// (src/harness/claudeUsage.ts). Events are the recorded shapes in tests/fixtures/live-usage-events.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { claudeLiveUsage, claudeLimitResetsAt } from '../shared/claudeRateLimit.mjs';
import { createUsageRefresher, mergeUsage, parseUsageText } from '../src/harness/claudeUsage.ts';

const req = createRequire(import.meta.url);
const { createUsageSchedule, loginAccounts } = req('../electron/harness/claude/usageSchedule.cjs');
const { UsageRefresh } = req('../electron/identity/contract/usageRefresh.cjs');
const { claude: ev } = JSON.parse(fs.readFileSync(new URL('./fixtures/live-usage-events.json', import.meta.url), 'utf8'));
const MIN = 60_000;
const WEEK_RESET = 1792346400;
const FIVE_H_RESET = 1792249200;

test('every window a newer CLI reports becomes a usage window under the name /usage gives it', () => {
  assert.deepEqual(claudeLiveUsage(ev.allowed.rate_limit_info, 5), {
    windows: [
      { label: '5h', usedPercent: 42, resetsAt: FIVE_H_RESET },
      { label: 'Weekly', usedPercent: 83, resetsAt: WEEK_RESET },
    ],
    status: 'allowed',
    at: 5,
  });
  assert.equal(claudeLiveUsage(ev.warning.rate_limit_info, 5).windows[1].usedPercent, 91);
  // as a real CLI sent it: the window in question named beside every window, which win
  assert.deepEqual(claudeLiveUsage(ev.recorded.rate_limit_info, 5).windows, [
    { label: '5h', usedPercent: 31, resetsAt: 1792236000 },
    { label: 'Weekly', usedPercent: 35, resetsAt: 1792627200 },
  ]);
  // an older CLI names the one window in question; one with no figures says nothing about usage
  assert.deepEqual(claudeLiveUsage(ev.olderCliAllowed.rate_limit_info, 5).windows, [
    { label: '5h', usedPercent: 12, resetsAt: FIVE_H_RESET },
  ]);
  assert.deepEqual(claudeLiveUsage(ev.noFigures.rate_limit_info, 5), { windows: [], status: 'allowed', at: 5 });
  assert.deepEqual(claudeLiveUsage({ utilization: 0.3 }, 5).windows, [{ label: 'Limit', usedPercent: 30, resetsAt: null }]);
  assert.deepEqual(
    claudeLiveUsage({ unifiedWindows: { seven_day_opus: { utilization: 0.5 }, other: { utilization: 0.1, resetsAt: -1 } } }, 5).windows,
    [
      { label: 'Weekly Opus', usedPercent: 50, resetsAt: null },
      { label: 'other', usedPercent: 10, resetsAt: null },
    ],
  );
  // anything else is no usage
  for (const info of [
    null,
    undefined,
    'x',
    { unifiedWindows: 'x' },
    { unifiedWindows: { five_hour: null, seven_day: { utilization: '1' } } },
  ])
    assert.deepEqual(claudeLiveUsage(info, 5), { windows: [], status: null, at: 5 });
});

test('a refusal is its window used up until its reset, whatever fraction came with it', () => {
  assert.deepEqual(claudeLiveUsage(ev.rejectedWeekly.rate_limit_info, 5).windows, [
    { label: '5h', usedPercent: 12, resetsAt: FIVE_H_RESET },
    { label: 'Weekly', usedPercent: 100, resetsAt: WEEK_RESET },
  ]);
  assert.deepEqual(claudeLiveUsage(ev.olderCliRejected.rate_limit_info, 5).windows, [
    { label: '5h', usedPercent: 100, resetsAt: FIVE_H_RESET },
  ]);
  // a refusal with no reset of its own keeps the one its window gave
  assert.deepEqual(
    claudeLiveUsage({ status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 7 } } }, 5)
      .windows,
    [{ label: '5h', usedPercent: 100, resetsAt: 7 }],
  );
  // a refusal that names no reset anywhere: its window is used up, until a time nobody knows
  assert.deepEqual(claudeLiveUsage({ status: 'rejected', rateLimitType: 'seven_day' }, 5).windows, [
    { label: 'Weekly', usedPercent: 100, resetsAt: null },
  ]);
  // extra usage running out is no plan window: nothing is added for it
  assert.deepEqual(claudeLiveUsage({ status: 'rejected', rateLimitType: 'overage', resetsAt: 9 }, 5).windows, []);
  assert.equal(claudeLimitResetsAt({ status: 'rejected', rateLimitType: 'overage', resetsAt: 9 }), 9000);
  assert.equal(claudeLimitResetsAt(ev.rejectedWeekly.rate_limit_info), WEEK_RESET * 1000);
  assert.equal(claudeLimitResetsAt(ev.olderCliRejected.rate_limit_info), FIVE_H_RESET * 1000);
  // not a refusal, or a refusal that names no reset
  assert.equal(claudeLimitResetsAt(ev.warning.rate_limit_info), null);
  assert.equal(claudeLimitResetsAt({ status: 'rejected' }), null);
  assert.equal(claudeLimitResetsAt(null), null);
});

function schedule(
  o: { configIdOf?: (a: string | undefined) => string; accountOf?: (l: string) => string | null; loginsOf?: (l: string) => string[] } = {},
) {
  const clock = { t: Date.UTC(2026, 9, 17, 12) };
  const reads: string[] = [];
  const policy = new UsageRefresh({ now: () => clock.t });
  const s = createUsageSchedule({
    read: async (_bin: string, account: string | undefined) => (reads.push(String(account)), 'Current session: 3% used'),
    measuredAt: () => clock.t,
    configIdOf: o.configIdOf ?? ((account: string | undefined) => account ?? 'cur'),
    active: () => 'cur',
    policy,
    now: () => clock.t,
    accountOf: o.accountOf,
    loginsOf: o.loginsOf,
  });
  return { s, clock, reads, policy };
}

test("main keeps what the login's turns reported beside its polled answer, window by window, with no window open", async () => {
  const { s, clock } = schedule();
  // nothing reported yet: the answer is the poll alone
  assert.equal((await s.usage('bin', 'a', 'now')).live, undefined);
  clock.t += MIN;
  const heardAt = clock.t;
  s.heard('a', ev.allowed.rate_limit_info);
  clock.t += MIN;
  // an older CLI's event names only the 5h window: the weekly one stays as heard before, dated then
  s.heard('a', ev.olderCliRejected.rate_limit_info);
  const r = await s.usage('bin', 'a', 'surface');
  assert.equal(r.state, 'success');
  assert.deepEqual(r.live, {
    windows: [
      { label: '5h', usedPercent: 100, resetsAt: FIVE_H_RESET, at: clock.t },
      { label: 'Weekly', usedPercent: 83, resetsAt: WEEK_RESET, at: heardAt },
    ],
    status: 'rejected',
    at: clock.t,
  });
  // an event with no figures changes nothing; another login's report is its own
  s.heard('a', ev.noFigures.rate_limit_info);
  s.heard('b', ev.warning.rate_limit_info);
  assert.deepEqual((await s.usage('bin', 'a', 'surface')).live, r.live);
  assert.equal((await s.usage('bin', 'b', 'surface')).live.windows[1].usedPercent, 91);
  // signed in again (perhaps as another account): what the old sign-in reported is gone
  s.clear('a');
  assert.equal((await s.usage('bin', 'a', 'surface')).live, undefined);
  // a removed login keeps nothing: no report, no hold
  s.heard('b', ev.rejectedWeekly.rate_limit_info);
  s.forget('b');
  assert.equal((await s.usage('bin', 'b', 'background')).live, undefined);
});

test("a refused turn moves the login's next timed read to the reset; one with no figures is read at the next tick", async () => {
  const { s, clock, reads } = schedule();
  clock.t = WEEK_RESET * 1000 - 3 * 60 * MIN;
  await s.usage('bin', 'a', 'now');
  s.used('a');
  s.heard('a', ev.rejectedWeekly.rate_limit_info);
  for (let i = 0; i < 35; i++) {
    clock.t += 5 * MIN;
    await s.usage('bin', 'a', 'background');
  }
  assert.deepEqual(reads, ['a'], 'no timed read before the reset');
  clock.t = WEEK_RESET * 1000;
  assert.equal((await s.usage('bin', 'a', 'background')).cached, false);
  assert.deepEqual(reads, ['a', 'a']);
  // an assistant rate_limit error with no event: read at the next tick, which learns the reset
  s.limited('b');
  await s.usage('bin', 'b', 'background');
  clock.t += 1;
  s.limited('b');
  assert.equal((await s.usage('bin', 'b', 'background')).cached, false);
  assert.deepEqual(reads, ['a', 'a', 'b', 'b']);
});

test("a key's folder never answers with the login's live figures", async () => {
  const { s } = schedule({ configIdOf: () => 'key-apiKey' });
  s.heard('a', ev.rejectedWeekly.rate_limit_info);
  assert.equal((await s.usage('bin', 'a', 'now')).live, undefined);
});

// No store or CLI process: `readings` stands in for the window's store, noteReading merges as noteUsage does.
function refresher(read: () => Promise<any>) {
  const readings: Record<string, any> = {};
  const noted: number[] = [];
  const refresh = createUsageRefresher({
    read,
    current: (id) => readings[id] ?? null,
    noteReading: (id, reading) => {
      noted.push(reading!.at);
      readings[id] = mergeUsage(readings[id] ?? null, reading);
    },
    noteFetch: (id, state, error) => (readings[id] = { windows: [], at: 0, ...readings[id], fetchState: state, fetchError: error ?? null }),
  });
  return { refresh, readings, noted };
}

test("a window merges main's live figures with the poll by when each was measured, in both orders", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 17, 12) });
  const live = (at: number) => ({ ...claudeLiveUsage(ev.rejectedWeekly.rate_limit_info, at) });
  const text = 'Current session: 12% used · resets 3pm (UTC)\nCurrent week (all models): 60% used · resets Oct 18 at 6pm (UTC)';
  // the poll is older than the turn's refusal: the limit stands
  const older = refresher(async () => ({ state: 'success', text, measuredAt: Date.now() - 10 * MIN, live: live(Date.now()) }));
  await older.refresh('a', 'surface');
  assert.equal(older.readings.a.windows.find((w: any) => w.label === 'Weekly').usedPercent, 100);
  assert.equal(older.readings.a.at, Date.now());
  // asked again: the same report is not noted twice (the store drops the poll's unchanged merge itself)
  await older.refresh('a', 'surface');
  assert.equal(older.noted.filter((at) => at === Date.now()).length, 1);
  // a poll measured after the report replaces it
  const newer = refresher(async () => ({ state: 'success', text, measuredAt: Date.now(), live: live(Date.now() - 10 * MIN) }));
  await newer.refresh('a', 'surface');
  assert.equal(newer.readings.a.windows.find((w: any) => w.label === 'Weekly').usedPercent, 60);
  assert.deepEqual(newer.noted, [Date.now()], 'the older report is not noted');
  // a failed read still brings the report; one with no windows brings nothing
  const failed = refresher(async () => ({ state: 'error', error: 'boom', live: live(Date.now()) }));
  await failed.refresh('a', 'surface');
  assert.equal(failed.readings.a.windows.length, 2);
  const empty = refresher(async () => ({ state: 'error', error: 'boom', live: { windows: [], status: null, at: Date.now() } }));
  await empty.refresh('a', 'surface');
  assert.deepEqual(empty.readings.a.windows, []);
  assert.deepEqual(parseUsageText(text)?.windows.length, 2);
  // a store that holds nothing for the login yet takes the report as it is
  const noted: unknown[] = [];
  const bare = createUsageRefresher({
    read: async () => ({ state: 'error', error: 'boom', live: live(Date.now()) }),
    current: () => null,
    noteReading: (_id, reading) => noted.push(reading),
    noteFetch: () => {},
  });
  await bare('a', 'surface');
  assert.deepEqual(noted, [live(Date.now())]);
});

test('two logins of one server account are one quota: a report on either is both, a hold holds both', async () => {
  const server: Record<string, string> = { cli: 'acct-1', added: 'acct-1' };
  const { s, clock, reads } = schedule({
    accountOf: (l) => server[l] ?? null,
    loginsOf: (l) => (server[l] ? ['added', 'cli'] : [l]),
  });
  for (const l of ['added', 'cli', 'other']) await s.usage('bin', l, 'now');
  reads.length = 0;
  s.heard('cli', ev.rejectedWeekly.rate_limit_info);
  const shown = (await s.usage('bin', 'added', 'surface')).live;
  assert.equal(shown.windows.find((w: any) => w.label === 'Weekly').usedPercent, 100);
  assert.deepEqual((await s.usage('bin', 'cli', 'surface')).live, shown);
  // a login whose account is not known is its own
  assert.equal((await s.usage('bin', 'other', 'surface')).live, undefined);
  // the hold is the account's: neither login is read by the timer before the reset
  s.used('added');
  s.used('cli');
  clock.t += 10 * MIN;
  for (const l of ['added', 'cli']) await s.usage('bin', l, 'background');
  assert.deepEqual(reads, []);
  // a refusal with no figures on one login has both read at the next tick
  clock.t = WEEK_RESET * 1000 + MIN;
  for (const l of ['added', 'cli']) await s.usage('bin', l, 'background');
  reads.length = 0;
  s.limited('added');
  for (const l of ['added', 'cli']) await s.usage('bin', l, 'background');
  assert.deepEqual(reads, ['added', 'cli']);
  // signing one login in again keeps the account's reading (a new sign-in names its own account)
  s.clear('cli');
  assert.deepEqual((await s.usage('bin', 'added', 'surface')).live, shown);
  // a login that is not among those sharing (loginsOf left it out) still holds itself
  const lone = schedule({ loginsOf: () => ['x'] });
  lone.s.heard('y', ev.rejectedWeekly.rate_limit_info);
  assert.equal((await lone.s.usage('bin', 'y', 'surface')).live.windows.length, 2);
});

test('which server account each login is comes from the logins main holds; with none, each login is its own', () => {
  assert.deepEqual([loginAccounts(() => null).accountOf('a'), loginAccounts(() => null).loginsOf('a')], [null, ['a']]);
  const accts: any = {
    cliLogin: { last: { read: 'ok', who: { accountUuid: 'u-1' } } },
    sameAccounts: () => ({ default: 'work' }),
  };
  const m = loginAccounts(() => accts);
  assert.equal(m.accountOf('default'), 'u-1');
  assert.deepEqual(m.loginsOf('default'), ['work', 'default']);
  assert.deepEqual(m.loginsOf('work'), ['work', 'default']);
  assert.deepEqual(m.loginsOf('alone'), ['alone']);
});

test("extra usage (overage) is no plan window: it is shown nowhere and counts toward no login's usage", () => {
  const info = {
    status: 'allowed',
    unifiedWindows: {
      five_hour: { utilization: 0.2, resetsAt: 7 },
      seven_day_overage_included: { utilization: 0.9, resetsAt: 8 },
    },
  };
  assert.deepEqual(claudeLiveUsage(info, 5).windows, [{ label: '5h', usedPercent: 20, resetsAt: 7 }]);
  // an older CLI naming the overage window, and a refusal of it, leave the plan windows alone
  assert.deepEqual(claudeLiveUsage({ rateLimitType: 'overage', utilization: 0.4 }, 5).windows, []);
  assert.deepEqual(claudeLiveUsage({ status: 'rejected', rateLimitType: 'overage', resetsAt: 9 }, 5).windows, []);
  const { LoginMarks } = req('../electron/identity/contract/loginMarks.cjs');
  const marks = new LoginMarks();
  marks.usage({ login: true }, 'a', info, 5);
  assert.equal(marks.get('a').left, 80);
  // the one window an older CLI names counts only when it is a plan window
  marks.usage({ login: true }, 'b', { status: 'allowed', rateLimitType: 'overage', utilization: 0.9 }, 5);
  assert.equal(marks.get('b').left, 100);
  marks.usage({ login: true }, 'b', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.9 }, 5);
  assert.equal(marks.get('b').left, 10);
});
