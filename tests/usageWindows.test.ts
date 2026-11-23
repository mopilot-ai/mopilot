// Quota windows shared by every harness: their names, what is left, the tightest one and Codex's windows.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const { windowLabel, percentLeft, managedWindows, tightestWindow, windowSuffix, until, resetWhen } = await import(
  '../src/harness/usageWindows.ts'
);
const { codexAccounts, accountStatusText } = await import('../src/harness/accounts.ts');
const pool = (accounts: any[], active: string | null) => ({ active, autoSwitch: true, pool: 'spread', relay: true, login: null, accounts });
const managed = (id: string, limits: any) => ({
  id,
  email: 'a@example.com',
  planType: 'prolite',
  kind: 'chatgpt',
  baseUrl: null,
  isDefault: true,
  status: 'ok',
  error: null,
  limits,
  chats: 0,
});

test('a window is named by its length, in minutes, hours, days or Weekly', () => {
  assert.deepEqual([null, undefined, 0, 45, 60, 300, 2880, 10080].map(windowLabel), [
    'Limit',
    'Limit',
    'Limit',
    '45m',
    '1h',
    '5h',
    '2d',
    'Weekly',
  ]);
});

test('percent left is whole and stays within 0 to 100', () => {
  assert.deepEqual([0, 24.4, 24.6, 100, 120, -5].map(percentLeft), [100, 76, 75, 0, 0, 100]);
});

test('a Codex reading gives each of its windows in order, and none when there is no reading', () => {
  assert.deepEqual(managedWindows(null), []);
  assert.deepEqual(managedWindows(undefined), []);
  assert.deepEqual(managedWindows({ primary: null, secondary: null, used: 10, reached: false, resetsAt: null, at: 1 }), []);
  assert.deepEqual(
    managedWindows({
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 99 },
      secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: null },
      used: 80,
      reached: false,
      resetsAt: null,
      at: 1,
    }),
    [
      { label: '5h', usedPercent: 30, resetsAt: 99 },
      { label: 'Weekly', usedPercent: 80, resetsAt: null },
    ],
  );
  // a window without a reset time is read as unknown
  assert.deepEqual(managedWindows({ secondary: { usedPercent: 5, windowDurationMins: null } } as any), [
    { label: 'Limit', usedPercent: 5, resetsAt: null },
  ]);
});

test('the tightest window is the one with the most used; the first wins a tie', () => {
  assert.equal(tightestWindow([]), null);
  const a = { label: '5h', usedPercent: 40, resetsAt: null };
  const b = { label: 'Weekly', usedPercent: 90, resetsAt: null };
  const c = { label: 'Weekly Opus', usedPercent: 90, resetsAt: null };
  assert.equal(tightestWindow([a, b, c]), b);
  assert.equal(tightestWindow([a]), a);
});

test('a window is named after "x% left" only when it has a real name', () => {
  const w = (label: string) => ({ label, usedPercent: 1, resetsAt: null });
  assert.equal(windowSuffix(null), '');
  assert.equal(windowSuffix(w('Usage')), '');
  assert.equal(windowSuffix(w('Limit')), '');
  assert.equal(windowSuffix(w('5h')), ' (5h)');
  assert.equal(windowSuffix(w('Weekly')), ' (weekly)');
  assert.equal(windowSuffix(w('Weekly Opus')), ' (weekly Opus)');
});

test('until names the time left in days, hours or minutes, never below zero', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  try {
    const now = 1_000_000;
    assert.equal(until(now + 2 * 86400 + 3 * 3600), '2d 3h');
    assert.equal(until(now + 4 * 3600 + 10 * 60), '4h 10m');
    assert.equal(until(now + 12 * 60), '12m');
    assert.equal(until(now - 50), '0m');
  } finally {
    mock.timers.reset();
  }
});

test('a window limits until its reset; a reset not known keeps it limiting', async () => {
  const { resetAhead, windowLimited } = await import('../src/harness/usageWindows.ts');
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual([null, undefined, 0, now + 60, now - 60].map(resetAhead), [true, true, true, true, false]);
  assert.equal(windowLimited({ usedPercent: 100, resetsAt: now + 60 }), true);
  assert.equal(windowLimited({ usedPercent: 120, resetsAt: null }), true);
  assert.equal(windowLimited({ usedPercent: 100, resetsAt: now - 60 }), false);
  assert.equal(windowLimited({ usedPercent: 99.5, resetsAt: null }), false);
});

test('Codex: windows whose reset passed since the reading stay listed, with nothing known left (#1582)', () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const ahead = Math.floor(Date.now() / 1000) + 3600;
  const limits = (secondaryReset: number) => ({
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: past },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: secondaryReset },
    used: 100,
    reached: false,
    resetsAt: past,
    at: Date.now() - 3 * 3600_000,
  });
  const one = (l: any) =>
    codexAccounts({
      accounts: pool([managed('default', l)], 'default') as any,
      account: null,
      rateLimits: null,
    }).active!;
  const some = one(limits(ahead));
  assert.equal(some.left, 70, 'the window still known');
  const none = one(limits(past));
  assert.equal(none.left, null);
  assert.equal(none.usage.windows.length, 2, 'its windows are still shown, as not known');
  assert.match(accountStatusText(none).text, /^Reset since last read · updated 180m ago$/);
  // the live app-server snapshot follows the same rule
  const live = codexAccounts({
    accounts: pool([], null) as any,
    account: { type: 'chatgpt', email: 'solo@example.com', planType: 'plus' },
    rateLimits: { rateLimits: { primary: { usedPercent: 90, resetsAt: past }, secondary: { usedPercent: 20, resetsAt: ahead } } },
  } as any).active!;
  assert.equal(live.left, 80);
});

test('a reset is said with its clock time: in so long and at what time within a day, the day and time beyond', () => {
  const now = 1_000_000_000_000;
  mock.timers.enable({ apis: ['Date'], now });
  try {
    const at = (sec: number) => new Date(sec * 1000);
    const soon = now / 1000 + 2 * 3600 + 5 * 60;
    assert.equal(
      resetWhen({ resetsAt: soon }),
      `Resets in 2h 5m · ${at(soon).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    );
    const day = (sec: number) => at(sec).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const later = now / 1000 + 3 * 86400;
    assert.equal(resetWhen({ resetsAt: later }), `Resets in 3d 0h · ${day(later)}`);
    // just after a weekly reset the next is nearly a week off: the weekday alone would read as today's
    const week = now / 1000 + 7 * 86400 - 3600;
    assert.equal(resetWhen({ resetsAt: week }), `Resets in 6d 23h · ${day(week)}`);
    // a reset already past says nothing; only the provider's words, or nothing at all, are kept as they are
    assert.equal(resetWhen({ resetsAt: now / 1000 - 60 }), null);
    assert.equal(resetWhen({ resetsAt: null, resetsText: 'Oct 9 at 12:29am' }), 'Resets Oct 9 at 12:29am');
    assert.equal(resetWhen({ resetsAt: null }), null);
    assert.equal(resetWhen({}), null);
  } finally {
    mock.timers.reset();
  }
});

test("a Codex login with no pool shows each of the app-server's windows with its reset, never one nameless figure", () => {
  const live = codexAccounts({
    accounts: pool([], null) as any,
    account: { type: 'chatgpt', email: 'solo@example.com', planType: 'plus' },
    rateLimits: {
      rateLimits: {
        primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 50 },
        secondary: { usedPercent: 40, windowDurationMins: 10080 },
      },
    },
  } as any).active!;
  assert.deepEqual(live.usage, {
    windows: [
      { label: '5h', usedPercent: 12, resetsAt: 50 },
      { label: 'Weekly', usedPercent: 40, resetsAt: null },
    ],
    source: 'live',
    at: null,
  });
  // a window with no figure counts as none used; a model-specific limit is not the plan's
  const partial = codexAccounts({
    accounts: pool([], null) as any,
    account: { type: 'chatgpt', email: null, planType: null },
    rateLimits: { rateLimits: { primary: { usedPercent: null } } },
  } as any).active!;
  assert.deepEqual(partial.usage.windows, [{ label: 'Limit', usedPercent: 0, resetsAt: null }]);
  const other = codexAccounts({
    accounts: pool([], null) as any,
    account: { type: 'chatgpt' },
    rateLimits: { rateLimits: { limitId: 'gpt-x', primary: { usedPercent: 10 } } },
  } as any).active!;
  assert.deepEqual(other.usage.windows, []);
});
