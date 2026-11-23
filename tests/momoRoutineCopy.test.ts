// How Settings › MoMo › Routines words a schedule (src/components/momo/routineCopy.ts, #2139): the one time main writes as an hour ("at 18", "at 10:30") on a 12-hour clock, and everything else as main wrote it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenText } from '../src/components/momo/routineCopy.ts';

test('a schedule with one time reads on a 12-hour clock, whatever its days', () => {
  assert.equal(whenText('Every day at 8'), 'Every day at 8:00 AM');
  assert.equal(whenText('Every Sunday at 18'), 'Every Sunday at 6:00 PM');
  assert.equal(whenText('Every day at 10:30'), 'Every day at 10:30 AM');
  assert.equal(whenText('Every weekday at 9'), 'Every weekday at 9:00 AM');
  assert.equal(whenText('Every month on the 1st at 9'), 'Every month on the 1st at 9:00 AM');
});

test('midnight is 12 AM and noon is 12 PM', () => {
  assert.equal(whenText('Every day at 0'), 'Every day at 12:00 AM');
  assert.equal(whenText('Every day at 12'), 'Every day at 12:00 PM');
  assert.equal(whenText('Every day at 23:45'), 'Every day at 11:45 PM');
});

test('several times, no time, or a time that is none are left as main wrote them', () => {
  assert.equal(whenText('Every day at 8 and 18'), 'Every day at 8 and 18');
  assert.equal(whenText('Every week on Monday'), 'Every week on Monday');
  assert.equal(whenText('FREQ=HOURLY;INTERVAL=2'), 'FREQ=HOURLY;INTERVAL=2');
  assert.equal(whenText('Every day at 24'), 'Every day at 24');
  assert.equal(whenText('Every day at 8:75'), 'Every day at 8:75');
});
