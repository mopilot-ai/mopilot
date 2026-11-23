// shared/calendarDay.mjs: the ISO week of a date, the line that tells an agent today, and the note placing the dates a
// browser result names relative to today (#1381 stab1: Codex read "delivered Oct 8" as more than 30 days before Oct 20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarNow, datesNote, isoWeek, todayLine } from '../shared/calendarDay.mjs';

const LA = calendarNow(new Date('2026-10-21T03:00:00Z'), 'America/Los_Angeles');
const text = (t: string) => ({ type: 'text', text: t });

test('ISO weeks start on Monday, and week 1 holds the first Thursday, across year ends', () => {
  assert.equal(isoWeek(2026, 10, 19), 43, 'a Monday');
  assert.equal(isoWeek(2026, 10, 25), 43, 'the Sunday of the same week');
  assert.equal(isoWeek(2026, 10, 26), 44);
  assert.equal(isoWeek(2025, 12, 29), 1, 'a December Monday already in the next year’s week 1');
  assert.equal(isoWeek(2027, 1, 1), 53, 'a January Friday still in the last year’s week 53');
  assert.equal(isoWeek(2027, 1, 4), 1);
});

test("today is named in the chat's time zone, which can be another day than UTC", () => {
  assert.equal(
    todayLine(LA),
    'Today is Tuesday, 2026-10-20 (ISO week 43, America/Los_Angeles). This week is 2026-10-19 to 2026-10-25 (Monday to Sunday); last week was 2026-10-12 to 2026-10-18.',
  );
  const tokyo = calendarNow(new Date('2026-10-21T03:00:00Z'), 'Asia/Tokyo');
  assert.equal(
    todayLine(tokyo),
    'Today is Wednesday, 2026-10-21 (ISO week 43, Asia/Tokyo). This week is 2026-10-19 to 2026-10-25 (Monday to Sunday); last week was 2026-10-12 to 2026-10-18.',
  );
  assert.match(
    todayLine(),
    /^Today is [A-Z][a-z]+day, \d{4}-\d{2}-\d{2} \(ISO week \d{1,2}, [^)]+\)\. This week is \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2} \(Monday to Sunday\); last week was \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\.$/,
  );
});

test('this week and last week are named from the date: Monday, Sunday, across months and years (#3571)', () => {
  const weeks = (y: number, m: number, d: number) =>
    todayLine({ year: y, month: m, day: d, weekday: 'X', week: 1, timeZone: 'UTC' }).replace(/^.*\. This week is /, '');
  // a Sunday: the week that ends today is THIS week; last week ended last Sunday (the G12 weekly-report runs took the former for the latter)
  assert.equal(weeks(2026, 11, 8), '2026-11-02 to 2026-11-08 (Monday to Sunday); last week was 2026-10-26 to 2026-11-01.');
  // a Monday starts its own week
  assert.equal(weeks(2026, 11, 2), '2026-11-02 to 2026-11-08 (Monday to Sunday); last week was 2026-10-26 to 2026-11-01.');
  // a Saturday and a Thursday in the middle of the week
  assert.equal(weeks(2026, 11, 7), '2026-11-02 to 2026-11-08 (Monday to Sunday); last week was 2026-10-26 to 2026-11-01.');
  assert.equal(weeks(2026, 11, 5), '2026-11-02 to 2026-11-08 (Monday to Sunday); last week was 2026-10-26 to 2026-11-01.');
  // a year end, and the end of February in a leap year
  assert.equal(weeks(2026, 1, 1), '2025-12-29 to 2026-01-04 (Monday to Sunday); last week was 2025-12-22 to 2025-12-28.');
  assert.equal(weeks(2028, 3, 1), '2028-02-28 to 2028-03-05 (Monday to Sunday); last week was 2028-02-21 to 2028-02-27.');
});

test('the dates a result names are placed from today, once each, in every written form', () => {
  const [note] = datesNote(
    [
      text('Placed: 2026-08-19 10:10\nNote: Promised delivery 2026-10-06. Delivered 2026-10-08.'),
      { type: 'image' },
      text('Shipped Oct 1, 2026 · due October 22 2026 · 21 Oct. 2026 · Sept 30, 2026 · again 2026-10-08 · 2026-10-20'),
    ],
    LA,
  );
  assert.equal(
    note.text,
    '<dates>\nToday is Tuesday, 2026-10-20 (ISO week 43, America/Los_Angeles). This week is 2026-10-19 to 2026-10-25 (Monday to Sunday); last week was 2026-10-12 to 2026-10-18.\n' +
      '2026-08-19: 62 days ago · 2026-10-06: 14 days ago · 2026-10-08: 12 days ago · 2026-10-01: 19 days ago · ' +
      '2026-10-22: in 2 days · 2026-10-21: in 1 day · 2026-09-30: 20 days ago · 2026-10-20: today\n</dates>',
  );
});

test('no note for a result with no real date: not-dates, impossible days, ids and the today line itself', () => {
  for (const t of ['SO-2026-10-08', '2026-10-081', '2026-02-30', 'Feb 30, 2026', 'version 1.2.3', 'Mayday 5 2026', todayLine(LA)])
    assert.deepEqual(datesNote([text(t)], LA), [], t);
  assert.deepEqual(datesNote([{ type: 'image' }], LA), []);
});

test('a result naming many dates places the first twenty and counts the rest', () => {
  const many = Array.from({ length: 23 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`).join(' ');
  const [note] = datesNote([text(many)], LA);
  assert.match(note.text, /2026-09-20: 30 days ago \(and 3 more\)\n<\/dates>$/);
  assert.doesNotMatch(note.text, /2026-09-21/);
  assert.equal(datesNote([text('2026-10-08')])[0].type, 'text', 'today defaults to now where the user is');
});
