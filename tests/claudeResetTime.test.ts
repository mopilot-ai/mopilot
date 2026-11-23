// Reset times Claude Code prints in /usage, turned into unix times (the text forms are its en-US formatter's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetTime } from '../shared/claudeResetTime.mjs';

const LA = 'America/Los_Angeles';
const sec = (ms: number) => ms / 1000;
// Oct 15 2026, 0:00 in Los Angeles (PDT, UTC-7)
const printed = Date.UTC(2026, 9, 15, 7);

test('a dated reset is that wall time in the zone the CLI names', () => {
  assert.equal(resetTime('Oct 15 at 1:50am', LA, printed), sec(Date.UTC(2026, 9, 15, 8, 50)));
  assert.equal(resetTime('Oct 21 at 5pm', LA, printed), sec(Date.UTC(2026, 9, 22, 0)));
  assert.equal(resetTime('Oct 21 at 12pm', 'UTC', printed), sec(Date.UTC(2026, 9, 21, 12)));
  assert.equal(resetTime('Oct 21 at 12am', 'UTC', printed), sec(Date.UTC(2026, 9, 21, 0)));
  // older ICU writes a comma for " at "; the AM marker may keep its periods
  assert.equal(resetTime('Oct 15, 1:50a.m.', LA, printed), sec(Date.UTC(2026, 9, 15, 8, 50)));
  assert.equal(resetTime('  oct 21 at 5 PM ', LA, printed), sec(Date.UTC(2026, 9, 22, 0)));
});

test('a date without a year is in the year it was printed; another year is spelled out', () => {
  assert.equal(resetTime('Jan 2 at 9am', 'UTC', printed), sec(Date.UTC(2026, 0, 2, 9)));
  assert.equal(resetTime('Jan 2, 2027 at 9am', 'UTC', printed), sec(Date.UTC(2027, 0, 2, 9)));
  assert.equal(resetTime('Sept 30 at 9am', 'UTC', printed), sec(Date.UTC(2026, 8, 30, 9)));
});

test('a bare time is its next occurrence after it was printed', () => {
  const morning = Date.UTC(2026, 9, 13, 10);
  assert.equal(resetTime('5pm', 'UTC', morning), sec(Date.UTC(2026, 9, 13, 17)));
  assert.equal(resetTime('5pm', 'UTC', Date.UTC(2026, 9, 13, 18)), sec(Date.UTC(2026, 9, 14, 17)));
  assert.equal(resetTime('11:30pm', LA, printed), sec(Date.UTC(2026, 9, 16, 6, 30)));
});

test('daylight saving: a time in the spring gap is the instant after it, and offsets follow the date', () => {
  // Mar 8 2026: Los Angeles skips 2:00-3:00
  assert.equal(resetTime('Mar 8 at 2:30am', LA, printed), sec(Date.UTC(2026, 2, 8, 10, 30)));
  // winter is PST (UTC-8)
  assert.equal(resetTime('Dec 1 at 5pm', LA, printed), sec(Date.UTC(2026, 11, 2, 1)));
});

test("without a zone it is this machine's", () => {
  assert.equal(resetTime('Oct 21 at 5pm', null, printed), sec(new Date(2026, 9, 21, 17).getTime()));
  assert.equal(resetTime('Oct 21 at 5pm', '  ', printed), sec(new Date(2026, 9, 21, 17).getTime()));
});

test('text the CLI does not print, impossible times and unknown zones give no time', () => {
  for (const text of [
    'tomorrow',
    'in 2h',
    '',
    'Oct 21',
    'Foo 3 at 1am',
    'Feb 30 at 1am',
    'Oct 0 at 1am',
    '13pm',
    '0am',
    'Oct 21 at 5:60pm',
    '17:00',
  ])
    assert.equal(resetTime(text, 'UTC', printed), null, text);
  assert.equal(resetTime('Oct 21 at 5pm', 'Mars/Olympus', printed), null);
});
