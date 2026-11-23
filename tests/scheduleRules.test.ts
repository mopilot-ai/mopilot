// The scheduler's rule reading (shared/schedule.mjs): times on the user's clock, the same times on every
// call (the run ledger keys runs by them), and the cron form Claude Desktop's tasks use.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RRule } = require('rrule');
const { scheduleRules, scheduleTime, toCron, fromCron, anchorDays, CATCH_UP_MS, ATTENTION_MS } = require('../shared/schedule.mjs');
const rules = scheduleRules(RRule);

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();

test('BYHOUR is the user’s clock, not UTC: 6:00 is 6:00 local', () => {
  const at = local(2026, 10, 12, 14, 7, 36, 981);
  assert.equal(rules.nextRun('FREQ=DAILY;BYHOUR=6;BYMINUTE=0', new Date(at))!.getTime(), local(2026, 10, 13, 6));
  assert.equal(rules.lastRun('FREQ=DAILY;BYHOUR=6;BYMINUTE=0', at), local(2026, 10, 12, 6));
  // across a DST change the wall-clock time holds
  assert.equal(rules.nextRun('FREQ=DAILY;BYHOUR=9;BYMINUTE=0', new Date(local(2026, 10, 31, 12)))!.getTime(), local(2026, 11, 1, 9));
});

test('a rule names the same times whatever second it is asked at', () => {
  const rule = 'FREQ=MINUTELY;INTERVAL=30';
  const a = rules.lastRun(rule, local(2026, 10, 12, 14, 7, 36, 981));
  const b = rules.lastRun(rule, local(2026, 10, 12, 14, 29, 59, 1));
  assert.equal(a, local(2026, 10, 12, 14, 0));
  assert.equal(b, a);
  assert.equal(rules.lastRun(rule, local(2026, 10, 12, 14, 30)), local(2026, 10, 12, 14, 30), 'inclusive');
  assert.equal(rules.nextRun(rule, new Date(local(2026, 10, 12, 14, 30)))!.getTime(), local(2026, 10, 12, 15, 0), 'strictly after');
  for (const r of [
    'FREQ=SECONDLY;INTERVAL=10',
    'RRULE:FREQ=HOURLY;INTERVAL=2',
    'FREQ=DAILY;INTERVAL=2',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
  ]) {
    const t = local(2026, 10, 12, 14, 7, 36, 981);
    assert.equal(rules.lastRun(r, t), rules.lastRun(r, t + 3), r);
    assert.ok(rules.nextRun(r, new Date(t))!.getTime() > t, r);
  }
});

test('weekly, monthly and yearly rules; a rule with its own DTSTART keeps it', () => {
  const at = local(2026, 10, 12, 14);
  assert.equal(rules.nextRun('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', new Date(at))!.getTime(), local(2026, 10, 13, 9));
  assert.equal(rules.nextRun('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9', new Date(at))!.getTime(), local(2026, 11, 1, 9));
  assert.equal(rules.lastRun('FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0', at), local(2026, 1, 1));
  assert.equal(rules.nextRun('FREQ=DAILY;DTSTART=20300101T100000Z', new Date(at))!.toISOString(), '2030-01-01T10:00:00.000Z');
  assert.equal(rules.lastRun('FREQ=DAILY;DTSTART=20300101T100000Z', at), null);
});

test('a rule reads as a sentence; one that does not parse reads as itself', () => {
  assert.equal(rules.describe('FREQ=HOURLY;INTERVAL=1'), 'Every hour');
  assert.equal(rules.describe('RRULE:FREQ=DAILY'), 'Every day');
  assert.equal(rules.describe('nonsense'), 'nonsense');
  // the time with its minutes (rrule's own text says 10:30 as "at 10", and drops a monthly rule's time)
  assert.equal(rules.describe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'), 'Every day at 9');
  assert.equal(rules.describe('FREQ=DAILY;BYHOUR=10;BYMINUTE=30'), 'Every day at 10:30');
  assert.equal(rules.describe('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18;BYMINUTE=5'), 'Every week on Monday, Wednesday at 18:05');
  assert.equal(rules.describe('FREQ=DAILY;BYHOUR=12,8;BYMINUTE=30'), 'Every day at 8:30 and 12:30');
  assert.equal(rules.describe('FREQ=DAILY;BYHOUR=8,12,18'), 'Every day at 8, 12 and 18');
  assert.equal(rules.describe('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=45'), 'Every month on the 1st at 9:45');
});

test('a rule that does not parse, or has no FREQ, names no time', () => {
  assert.equal(rules.nextRun('NOT A RULE'), null);
  assert.equal(rules.lastRun('NOT A RULE', Date.now()), null);
  assert.equal(rules.nextRun(''), null);
  assert.equal(rules.lastRun('', Date.now()), null);
  assert.ok(rules.nextRun('FREQ=DAILY') instanceof Date, 'the default `after` is now');
  assert.equal(rules.nextRun('FREQ=DAILY;DTSTART=20200101T000000Z;COUNT=1'), null, 'a rule with no times left');
});

test('cron for Claude Desktop: the rules it can say, null for the rest', () => {
  assert.equal(toCron('FREQ=DAILY;BYHOUR=6;BYMINUTE=0'), '0 6 * * *');
  assert.equal(toCron('RRULE:FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30'), '30 9 * * 1,5');
  assert.equal(toCron('FREQ=MINUTELY;INTERVAL=15'), '*/15 * * * *');
  assert.equal(toCron('FREQ=MINUTELY'), '* * * * *');
  assert.equal(toCron('FREQ=HOURLY;INTERVAL=6'), '0 */6 * * *');
  assert.equal(toCron('FREQ=HOURLY;BYMINUTE=5;BYDAY=SA'), '5 * * * 6');
  for (const r of [
    'FREQ=MINUTELY;INTERVAL=7',
    'FREQ=MINUTELY;BYMINUTE=3',
    'FREQ=MINUTELY;BYHOUR=3',
    'FREQ=HOURLY;INTERVAL=5',
    'FREQ=HOURLY;BYHOUR=3',
    'FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=2;BYHOUR=9',
    'FREQ=WEEKLY;BYHOUR=9',
    'FREQ=MONTHLY;BYHOUR=9',
    'FREQ=DAILY;BYHOUR=9;COUNT=3',
    'FREQ=DAILY;INTERVAL=0;BYHOUR=9',
    'FREQ=DAILY;BYHOUR=24',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=60',
    'FREQ=WEEKLY;BYDAY=1MO;BYHOUR=9',
    'FREQ',
  ])
    assert.equal(toCron(r), null, r);
});

test('cron rejects inherited object names as weekdays', () => {
  for (const day of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(toCron(`FREQ=WEEKLY;BYDAY=${day};BYHOUR=9`), null, day);
    assert.equal(toCron(`FREQ=HOURLY;BYDAY=MO,${day}`), null, day);
  }
  assert.equal(toCron('FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYHOUR=9'), '0 9 * * 0,1,2,3,4,5,6');
});

test('cron from Claude Desktop: the forms it writes, null for the rest', () => {
  assert.equal(fromCron('0 */6 * * *'), 'FREQ=HOURLY;INTERVAL=6;BYMINUTE=0');
  assert.equal(fromCron('5 * * * *'), 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=5');
  assert.equal(fromCron('0 9 * * 1-5'), 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(fromCron('0 9 * * 0,7'), 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=SU');
  assert.equal(fromCron('*/15 * * * *'), 'FREQ=MINUTELY;INTERVAL=15');
  assert.equal(fromCron('* * * * *'), 'FREQ=MINUTELY;INTERVAL=1');
  assert.equal(fromCron(' 30 8,17 * * * '), 'FREQ=DAILY;BYHOUR=8,17;BYMINUTE=30');
  for (const c of [
    '0 9 1 * *',
    '0 9 * 1 *',
    '*/7 * * * *',
    '0 */5 * * *',
    '*/5 9 * * *',
    '0 9 * * 5-1',
    '0 9 * * 8',
    '0 9 * * MON',
    '0 25 * * *',
    '0 9 * *',
    'x',
  ])
    assert.equal(fromCron(c), null, c);
});

test('anchor windows and the catch-up and attention spans', () => {
  assert.equal(anchorDays(0, 1), 400);
  assert.equal(anchorDays(60_000, 1), 2);
  assert.equal(anchorDays(3_600_000, 1), 8);
  assert.equal(CATCH_UP_MS, 7 * 86_400_000);
  assert.equal(ATTENTION_MS, 3_600_000);
});

test('persisted schedule times accept finite Date milliseconds and safely reject invalid values', () => {
  for (const value of [0, null, '1000', -1000, 8_640_000_000_000_000]) assert.equal(scheduleTime(value), Number(value));
  for (const value of [
    undefined,
    { valueOf: 0, toString: 0 },
    {},
    [],
    false,
    '',
    '   ',
    'Infinity',
    Infinity,
    -Infinity,
    NaN,
    'torn',
    1.5,
    1e100,
    8_640_000_000_000_001,
  ]) {
    assert.equal(scheduleTime(value), 0);
    assert.equal(scheduleTime(value, null), null);
    assert.equal(scheduleTime(value, 80), 80);
  }
});

test('a rule runs on the clock of the zone it was made in, wherever it is evaluated', () => {
  const { isTimeZone } = require('../shared/schedule.mjs');
  const r = rules;
  const daily9 = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
  // 9:00 in Tokyo is 00:00 UTC; in New York in July (EDT) it is 13:00 UTC
  const at = Date.UTC(2026, 6, 15, 12, 0);
  assert.equal(new Date(r.lastRun(daily9, at, 'Asia/Tokyo')!).toISOString(), '2026-07-15T00:00:00.000Z');
  assert.equal(r.nextRun(daily9, new Date(at), 'America/New_York')!.toISOString(), '2026-07-15T13:00:00.000Z');
  // across a daylight-saving change the wall time holds: 9:00 New York in January is 14:00 UTC
  assert.equal(r.nextRun(daily9, new Date(Date.UTC(2026, 0, 10, 15)), 'America/New_York')!.toISOString(), '2026-01-11T14:00:00.000Z');
  // a rule with its own DTSTART is in real time, whatever the zone
  const fixed = 'DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY';
  assert.equal(new Date(r.lastRun(fixed, at, 'Asia/Tokyo')!).toISOString(), '2026-07-15T00:00:00.000Z');
  assert.equal(isTimeZone('Europe/Berlin'), true);
  assert.equal(isTimeZone('Mars/Base'), false);
  assert.equal(isTimeZone(''), false);
  assert.equal(isTimeZone(7), false);
  assert.equal(isTimeZone('x'.repeat(65)), false);
});
