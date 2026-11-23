// MoMo's Routines rules (shared/momoRoutine.mjs, #2139): settings with defaults, quiet hours on the computer's clock across daylight saving and time zones, a routine's schedule from a time and days, and why a run may not start.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RRule } = require('rrule');
const { scheduleRules } = require('../shared/schedule.mjs');
const m = require('../shared/momoRoutine.mjs');
const rules = scheduleRules(RRule);

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const HOUR = 3_600_000;
const defaults = m.routineSettings({});

/** Run `fn` with the computer in time zone `tz`, then back. */
function inZone(tz: string, fn: () => void) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    process.env.TZ = before;
  }
}

test('clock text: 24-hour "HH:MM"; anything else is no time', () => {
  assert.equal(m.parseClock('07:05'), 425);
  assert.equal(m.parseClock(' 7:05 '), 425);
  assert.equal(m.parseClock('23:59'), 1439);
  assert.equal(m.parseClock('00:00'), 0);
  for (const bad of ['24:00', '7:60', '7', '', 'noon', 7, null, undefined]) assert.equal(m.parseClock(bad), null, String(bad));
});

test('settings: defaults for what is missing or not valid; null quiet hours or the same start and end mean none', () => {
  assert.deepEqual(defaults, {
    proactivity: 'default',
    quietHours: { start: 1320, end: 420 },
    paused: false,
  });
  for (const prefs of [null, 'x', [], { momo: [] }, { momo: { routines: 'x', brain: 7 } }])
    assert.deepEqual(m.routineSettings(prefs), defaults, JSON.stringify(prefs));
  const set = (routines: unknown) => m.routineSettings({ momo: { routines } });
  assert.equal(set({ proactivity: 'high' }).proactivity, 'high');
  assert.equal(set({ proactivity: 'loud' }).proactivity, 'default');
  assert.equal(set({ quietHours: null }).quietHours, null);
  assert.equal(set({ quietHours: { start: '06:00', end: '06:00' } }).quietHours, null);
  assert.deepEqual(set({ quietHours: { start: '13:00', end: '14:30' } }).quietHours, { start: 780, end: 870 });
  assert.deepEqual(set({ quietHours: { start: '25:00', end: '07:00' } }).quietHours, defaults.quietHours, 'a bad time keeps the default');
  assert.deepEqual(set({ quietHours: 'all day' }).quietHours, defaults.quietHours);
  assert.equal('feedAt' in set({ feedAt: '06:30' }), false, 'the edition time is gone');
  // routines have no brain of their own: they run on MoMo's one brain
  assert.equal('brain' in m.routineSettings({ momo: { brain: { routines: { harness: 'claude' } } } }), false);
  assert.equal(m.routinesBrainOf, undefined);
  assert.equal(m.routineSettings({ momo: { paused: true } }).paused, true);
  assert.equal(m.routineSettings({ momo: { paused: 'yes' } }).paused, false);
});

test('quiet hours: past midnight and within a day, start inclusive and end exclusive, none when off', () => {
  const night = { start: 22 * 60, end: 7 * 60 };
  assert.equal(m.inQuietHours(night, local(2030, 1, 8, 21, 59)), false);
  assert.equal(m.inQuietHours(night, local(2030, 1, 8, 22, 0)), true);
  assert.equal(m.inQuietHours(night, local(2030, 1, 9, 3, 0)), true);
  assert.equal(m.inQuietHours(night, local(2030, 1, 9, 6, 59)), true);
  assert.equal(m.inQuietHours(night, local(2030, 1, 9, 7, 0)), false);
  const lunch = { start: 12 * 60, end: 13 * 60 };
  assert.equal(m.inQuietHours(lunch, local(2030, 1, 9, 11, 59)), false);
  assert.equal(m.inQuietHours(lunch, local(2030, 1, 9, 12, 30)), true);
  assert.equal(m.inQuietHours(lunch, local(2030, 1, 9, 13, 0)), false);
  assert.equal(m.inQuietHours(null, local(2030, 1, 9, 3, 0)), false);
});

test('quiet hours across daylight saving: the wall clock decides, in the skipped and the repeated hour', () => {
  const early = { start: 1 * 60, end: 3 * 60 };
  // 2030-03-10: 02:00 PST jumps to 03:00 PDT. 01:59 is quiet; the next minute is 03:00, which is not
  const beforeJump = local(2030, 3, 10, 1, 59);
  assert.equal(m.inQuietHours(early, beforeJump), true);
  assert.equal(m.inQuietHours(early, beforeJump + 60_000), false);
  assert.equal(new Date(beforeJump + 60_000).getHours(), 3);
  // 2030-11-03: 01:00–02:00 happens twice. Both 01:30s are quiet, and 02:00 (PST) is not yet past the end
  const firstOneThirty = local(2030, 11, 3, 1, 30);
  assert.equal(m.inQuietHours(early, firstOneThirty), true);
  assert.equal(m.inQuietHours(early, firstOneThirty + HOUR), true, 'the repeated 01:30');
  assert.equal(new Date(firstOneThirty + HOUR).getHours(), 1);
  assert.equal(m.inQuietHours(early, firstOneThirty + 2 * HOUR), true, '02:30 PST');
  assert.equal(m.inQuietHours(early, firstOneThirty + 3 * HOUR), false, '03:30 PST');
});

test('a routine at 8:00 on the computer’s clock, through both daylight-saving changes', () => {
  const rule = m.routineRule({ time: '08:00' }).rrule;
  assert.equal(rule, 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0');
  // the day of the spring change is 23 hours long; 8:00 stays 8:00
  assert.equal(rules.lastRun(rule, local(2030, 3, 10, 12)), local(2030, 3, 10, 8));
  assert.equal(rules.nextRun(rule, new Date(local(2030, 3, 9, 9)))!.getTime(), local(2030, 3, 10, 8));
  assert.equal(local(2030, 3, 10, 8) - local(2030, 3, 9, 8), 23 * HOUR);
  // the fall change is 25 hours long
  assert.equal(rules.nextRun(rule, new Date(local(2030, 11, 2, 9)))!.getTime(), local(2030, 11, 3, 8));
  assert.equal(local(2030, 11, 3, 8) - local(2030, 11, 2, 8), 25 * HOUR);
  // at 7:59 the latest run is yesterday's
  assert.equal(rules.lastRun(rule, local(2030, 11, 3, 7, 59)), local(2030, 11, 2, 8));
});

test('another time zone: quiet hours and a routine follow the computer’s clock, half-hour zones included', () => {
  const now = Date.UTC(2030, 0, 9, 2, 0); // 18:00 the day before in Los Angeles, 07:30 in Kolkata, 15:45 in Chatham
  const night = { start: 22 * 60, end: 7 * 60 };
  assert.equal(m.localDay(now), '2030-01-08');
  assert.equal(m.inQuietHours(night, now), false);
  inZone('Asia/Kolkata', () => {
    assert.equal(m.localDay(now), '2030-01-09');
    assert.equal(m.inQuietHours(night, now), false, '07:30');
    assert.equal(m.inQuietHours(night, now - 31 * 60_000), true, '06:59');
    const rule = m.routineRule({ time: '08:00' }).rrule;
    assert.equal(rules.nextRun(rule, new Date(now))!.getTime(), Date.UTC(2030, 0, 9, 2, 30), '08:00 IST');
  });
  inZone('Pacific/Chatham', () => {
    assert.equal(m.localDay(now), '2030-01-09');
    assert.equal(m.inQuietHours({ start: 15 * 60 + 45, end: 16 * 60 }, now), true);
  });
});

test('the local day: midnight belongs to the new day, single digits are padded', () => {
  assert.equal(m.localDay(local(2030, 2, 3, 0, 0)), '2030-02-03');
  assert.equal(m.localDay(local(2030, 2, 2, 23, 59)), '2030-02-02');
  assert.equal(m.localDay(local(2030, 12, 31, 12)), '2030-12-31');
});

test('may a run start: not allowed first, then off, approval, quiet hours, and the routine limit', () => {
  const at = local(2030, 1, 9, 12);
  const night = local(2030, 1, 9, 23);
  const base = { at, settings: defaults, allowed: true, runsToday: 0, approved: true };
  const { approved: _a, ...unsaid } = base;
  assert.deepEqual(m.runDecision(unsaid), { ok: false, reason: 'not-approved' }, 'no answer is no approval');
  assert.deepEqual(m.runDecision(base), { ok: true });
  assert.deepEqual(m.runDecision({ ...base, allowed: false, at: night }), { ok: false, reason: 'not-allowed' });
  const off = { ...defaults, proactivity: 'off' };
  assert.deepEqual(m.runDecision({ ...base, settings: off }), { ok: false, reason: 'off' });
  const paused = { ...defaults, paused: true };
  assert.deepEqual(m.runDecision({ ...base, settings: paused }), { ok: false, reason: 'paused' });
  assert.deepEqual(m.runDecision({ ...base, allowed: false, settings: paused }), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(m.runDecision({ ...base, approved: false }), { ok: false, reason: 'not-approved' });
  assert.deepEqual(m.runDecision({ ...base, at: night }), { ok: false, reason: 'quiet-hours' });
  for (const level of ['low', 'default', 'high'] as const) {
    const settings = { ...defaults, proactivity: level };
    const runs = m.LIMITS[level].runs;
    assert.deepEqual(m.runDecision({ ...base, settings, runsToday: runs - 1 }), { ok: true }, level);
    assert.deepEqual(m.runDecision({ ...base, settings, runsToday: runs }), { ok: false, reason: 'limit' }, level);
  }
  assert.deepEqual(m.runDecision({ ...base, settings: { ...defaults, quietHours: null }, at: night }), { ok: true });
});

test('MoMo task ids: "momo." and an opaque id, which a scheduled task’s readable id never is', () => {
  assert.equal(m.momoTaskId('3f2a-9'), 'momo.3f2a-9');
  assert.equal(m.isMomoTaskId('momo.3f2a-9'), true);
  for (const id of ['momo-3f2a', 'momo.', 'momo./x', 'momo.a.b', 'daily-brief-1234', 7, null])
    assert.equal(m.isMomoTaskId(id), false, String(id));
});

test('one paragraph: the first, on one line, clipped with an ellipsis', () => {
  assert.equal(m.onePara('  Done: 3 PRs merged.\nAll green.\n\nDetails follow.'), 'Done: 3 PRs merged. All green.');
  assert.equal(m.onePara(''), '');
  assert.equal(m.onePara(null), '');
  assert.equal(m.onePara('abcdefghij', 6), 'abcde…');
  assert.equal(m.onePara('abcd efghij', 6), 'abcd…');
  assert.equal(m.onePara('abcdef', 6), 'abcdef');
  assert.equal(m.onePara('abcd😀xyz', 6), 'abcd…', 'never half an emoji');
});

test('a schedule as an RRULE: a time each day or on named days, a rule as given, and what can’t be one said', () => {
  const ok = (s: any) => m.routineRule(s).rrule;
  const no = (s: any) => m.routineRule(s).error;
  assert.equal(ok({ time: '09:00' }), 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0');
  assert.equal(ok({ time: '18:30', days: null }), 'FREQ=DAILY;BYHOUR=18;BYMINUTE=30;BYSECOND=0');
  assert.equal(ok({ time: '18:30', days: [] }), 'FREQ=DAILY;BYHOUR=18;BYMINUTE=30;BYSECOND=0');
  // named days, in any case or spelled out, each once and in week order
  assert.equal(ok({ time: '9:00', days: ['sunday', 'MO', 'mo', ' Fr '] }), 'FREQ=WEEKLY;BYDAY=MO,FR,SU;BYHOUR=9;BYMINUTE=0;BYSECOND=0');
  assert.equal(ok({ time: '07:00', days: [...m.WEEKDAYS] }), 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0;BYSECOND=0');
  assert.equal(ok({ rrule: ' FREQ=MONTHLY;BYMONTHDAY=1 ', time: '' }), 'FREQ=MONTHLY;BYMONTHDAY=1');
  assert.equal(ok({ rrule: 'FREQ=WEEKLY', days: [] }), 'FREQ=WEEKLY');
  // each one a real schedule the scheduler reads
  assert.ok(rules.nextRun(ok({ time: '9:00', days: ['TU'] }), new Date(local(2030, 3, 11))));
  assert.match(no({ rrule: 'FREQ=DAILY', time: '09:00' }), /not both/);
  assert.match(no({ rrule: 'FREQ=DAILY', days: 'MO' }), /not both/);
  for (const s of [{}, null, { rrule: '  ' }, { time: null, days: ['MO'] }]) assert.match(no(s), /Give the schedule/, JSON.stringify(s));
  assert.equal(no({ time: '9am' }), 'Not a time: 9am. Use 24-hour HH:MM.');
  for (const days of ['MO', ['Xmas'], [3], { 0: 'MO' }])
    assert.match(no({ time: '09:00', days }), /^Days are MO, TU/, JSON.stringify(days));
});

test('a rule as its time and days for the edit form: only the rules routineRule makes; any other is null', () => {
  assert.deepEqual(m.ruleParts('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'), { time: '09:00', days: [] });
  assert.deepEqual(m.ruleParts('RRULE:FREQ=DAILY;BYHOUR=7'), { time: '07:00', days: [] });
  assert.deepEqual(m.ruleParts('FREQ=WEEKLY;BYDAY=FR,MO;BYHOUR=18;BYMINUTE=5'), { time: '18:05', days: ['MO', 'FR'] });
  // each made back into the same schedule
  for (const s of [{ time: '06:45' }, { time: '21:00', days: ['SU', 'WE'] }])
    assert.equal(m.routineRule(m.ruleParts(m.routineRule(s).rrule)).rrule, m.routineRule(s).rrule);
  for (const r of [
    'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9',
    'FREQ=DAILY;BYHOUR=9,12',
    'FREQ=DAILY;BYHOUR=24',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=60',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=x',
    'FREQ=WEEKLY;BYHOUR=9',
    'FREQ=WEEKLY;BYDAY=XX;BYHOUR=9',
    'FREQ=DAILY;BYDAY=MO;BYHOUR=9',
    'FREQ=DAILY;FREQ=DAILY;BYHOUR=9',
    'FREQ=DAILY;BYHOUR=9;BYSECOND=30',
    'FREQ=DAILY;BYHOUR',
    'FREQ=DAILY;BYHOUR=9=1',
    'FREQ=DAILY',
    '',
    null,
  ])
    assert.equal(m.ruleParts(r), null, String(r));
});

test('a routine or its run that isn’t valid is a RoutineError with the code its writer is told', () => {
  const e = new m.RoutineError('too long', 'bad_args');
  assert.deepEqual([e instanceof Error, e.message, e.code], [true, 'too long', 'bad_args']);
  assert.equal(m.ROUTINE, 'momo-routine');
  assert.equal(m.FEED, undefined, 'the edition is gone');
});
