// Which nudges may reach the user now (#2139 P4, electron/momo/nudgeGate.cjs): nothing while MoMo is off or paused or at proactivity Off, or in quiet hours (on the Mac's clock, in the user's zone now, across daylight saving); likely loops kept, not delivered; the day's quota 0/2/6/12, 1 a day in week one; a dismissed kind comes less often; at most 3 a check, soonest due first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gate, MAX_PER_CHECK, WEEK_ONE, DISMISS_WINDOW } = require('../electron/momo/nudgeGate.cjs');

const D = 86_400_000;
const NOW = new Date(2030, 2, 20, 12, 0).getTime(); // noon on the Mac's clock
const settings = (o: any = {}) => ({ proactivity: 'default', quietHours: { start: 22 * 60, end: 7 * 60 }, paused: false, ...o });
const state = (o: any = {}) => ({ firstAt: NOW - 30 * D, delivered: [], dismissed: [], ...o });
const t = (loopId: string, trigger = 'stale', dueAt?: number) => ({
  loopId,
  trigger,
  key: `${trigger}:${loopId}`,
  at: NOW,
  ...(dueAt ? { dueAt } : {}),
});
const loops = (o: Record<string, any> = {}) =>
  new Map(
    Object.entries({
      a: { kind: 'todo', confidence: 'sure' },
      b: { kind: 'promise', confidence: 'sure' },
      c: { kind: 'date', confidence: 'sure' },
      d: { kind: 'todo', confidence: 'sure' },
      ...o,
    }),
  );
const run = (ts: any[], o: any = {}) =>
  gate(ts, {
    now: NOW,
    allowed: true,
    settings: settings(o.settings),
    state: state(o.state),
    loops: o.loops ?? loops(),
    ...(o.at ? { now: o.at } : {}),
  });
const reasons = (r: any) => r.held.map((h: any) => `${h.trigger.loopId}:${h.reason}`);

test('nothing goes while MoMo is off, paused or at proactivity Off', () => {
  for (const o of [
    { allowed: false },
    { settings: settings({ paused: true }) },
    { settings: settings({ proactivity: 'off' }) },
    { settings: settings({ proactivity: 'odd' }) },
  ]) {
    const r = gate([t('a')], { now: NOW, allowed: true, settings: settings(), state: state(), loops: loops(), ...o });
    assert.deepEqual(r.deliver, []);
    assert.deepEqual(reasons(r), ['a:off']);
  }
});

test('quiet hours hold every trigger, on the Mac’s clock across a daylight-saving change', () => {
  const night = new Date(2030, 2, 20, 23, 30).getTime();
  assert.deepEqual(reasons(run([t('a'), t('b')], { at: night })), ['a:quiet-hours', 'b:quiet-hours']);
  // the night clocks change (US: 2030-03-10, EU: 2030-03-31): 06:30 local is still quiet, 07:30 is not
  for (const day of [10, 31]) {
    assert.deepEqual(reasons(run([t('a')], { at: new Date(2030, 2, day, 6, 30).getTime() })), ['a:quiet-hours']);
    assert.equal(run([t('a')], { at: new Date(2030, 2, day, 7, 30).getTime() }).deliver.length, 1);
  }
  assert.equal(run([t('a')], { at: night, settings: settings({ quietHours: null }) }).deliver.length, 1, 'no quiet hours');
});

test('quiet hours follow the zone the Mac is in now', () => {
  const tz = process.env.TZ;
  try {
    // 03:00 UTC: night in London, the afternoon in Tokyo
    const at = Date.UTC(2030, 5, 1, 3, 0);
    process.env.TZ = 'Europe/London';
    assert.deepEqual(reasons(run([t('a')], { at })), ['a:quiet-hours']);
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(run([t('a')], { at }).deliver.length, 1);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('a likely loop, or one gone, is kept but not delivered', () => {
  const r = run([t('a'), t('gone')], { loops: loops({ a: { kind: 'todo', confidence: 'likely' } }) });
  assert.deepEqual(r.deliver, []);
  assert.deepEqual(reasons(r), ['a:low-confidence', 'gone:low-confidence']);
});

test('the day’s quota is the proactivity level’s, counted on the local day; at most MAX_PER_CHECK a check', () => {
  const yesterday = { at: NOW - D, loopId: 'x', kind: 'todo', trigger: 'due' };
  const today = (n: number) => Array.from({ length: n }, (_, i) => ({ at: NOW - i - 1, loopId: `x${i}`, kind: 'date', trigger: 'due' }));
  assert.deepEqual(
    reasons(
      run([t('a'), t('b'), t('c')], { settings: settings({ proactivity: 'low' }), state: state({ delivered: [yesterday, ...today(1)] }) }),
    ),
    ['b:quota', 'c:quota'],
  );
  assert.equal(run([t('a')], { settings: settings({ proactivity: 'high' }), state: state({ delivered: today(11) }) }).deliver.length, 1);
  assert.deepEqual(reasons(run([t('a')], { settings: settings({ proactivity: 'high' }), state: state({ delivered: today(12) }) })), [
    'a:quota',
  ]);
  const many = run([t('a'), t('b'), t('c'), t('d')], { settings: settings({ proactivity: 'high' }) });
  assert.equal(many.deliver.length, MAX_PER_CHECK);
  assert.deepEqual(reasons(many), ['d:per-check']);
});

test('in the first week at most one a day; with no first time yet it is week one', () => {
  const r = run([t('a'), t('b')], { state: state({ firstAt: NOW - 2 * D }) });
  assert.equal(r.deliver.length, 1);
  assert.deepEqual(reasons(r), ['b:week-one']);
  assert.equal(run([t('a'), t('b')], { state: state({ firstAt: undefined }) }).deliver.length, 1);
  assert.equal(run([t('a'), t('b')], { state: state({ firstAt: NOW - WEEK_ONE }) }).deliver.length, 2);
  // low (2 a day) in week one still says week-one; the week's cap and the level's agree at 1? no level is 1
  assert.deepEqual(
    reasons(run([t('a')], { state: state({ firstAt: NOW, delivered: [{ at: NOW - 1, loopId: 'x', kind: 'x', trigger: 'due' }] }) })),
    ['a:week-one'],
  );
});

test('each dismissal of a kind in 30 days adds a day between nudges of that kind', () => {
  const dismissed = [
    { at: NOW - D, kind: 'todo' },
    { at: NOW - 2 * D, kind: 'todo' },
    { at: NOW - DISMISS_WINDOW - 1, kind: 'todo' },
  ];
  const recent = { at: NOW - D, loopId: 'x', kind: 'todo', trigger: 'stale' };
  // two dismissals: a two-day gap; the last todo nudge was a day ago
  assert.deepEqual(reasons(run([t('a'), t('b')], { state: state({ dismissed, delivered: [recent] }) })), ['a:dismissed-kind']);
  // three days on: one todo may go, but not a second in the same check
  const r = run([t('a'), t('d')], { state: state({ dismissed, delivered: [{ ...recent, at: NOW - 3 * D }] }) });
  assert.deepEqual(
    r.deliver.map((x: any) => x.loopId),
    ['a'],
  );
  assert.deepEqual(reasons(r), ['d:dismissed-kind']);
  // no dismissal: two todos go together
  assert.equal(run([t('a'), t('d')]).deliver.length, 2);
});

test('due first (soonest first), then event, close, stale', () => {
  const r = run([t('a', 'stale'), t('b', 'close'), t('c', 'due', NOW + 2 * D), t('d', 'event')], {
    settings: settings({ proactivity: 'high' }),
  });
  assert.deepEqual(
    r.deliver.map((x: any) => x.trigger),
    ['due', 'event', 'close'],
  );
  const two = run([t('a', 'due', NOW + 5 * D), t('b', 'due', NOW + D)], { settings: settings({ proactivity: 'high' }) });
  assert.deepEqual(
    two.deliver.map((x: any) => x.loopId),
    ['b', 'a'],
  );
});
