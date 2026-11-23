// The card words both clients show (shared/host/cardLine.mjs): every row of "A card", the clock after the reminder, and "Sent from".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardLine, pausesIn, sentFrom, REMIND_MS, PAUSE_MS } from '../shared/host/cardLine.mjs';

const c = { now: 1_000_000_000, machineName: 'build-box', org: 'Acme' };

test('waiting: no clock before the reminder, then "Pauses in N min" by the minute, never under 1', () => {
  const at = (ago: number) => cardLine({ state: 'waiting', since: c.now - ago }, c).text;
  assert.equal(at(0), null);
  assert.equal(at(REMIND_MS - 1), null);
  assert.equal(at(REMIND_MS), 'Pauses in 20 min');
  assert.equal(at(REMIND_MS + 60_000 * 4 + 1), 'Pauses in 16 min');
  assert.equal(at(PAUSE_MS - 1), 'Pauses in 1 min');
  assert.equal(at(PAUSE_MS + 5_000), 'Pauses in 1 min');
  assert.equal(pausesIn(c.now - 5 * 60_000, c.now, 5 * 60_000, 60 * 60_000), 'Pauses in 55 min');
  assert.equal(cardLine({ state: 'waiting', since: c.now }, c).action, null);
});

test('sent: progress on the pressed button, no words', () => {
  assert.deepEqual(cardLine({ state: 'sent' }, c), { text: null, action: null, progress: true });
});

test('answered here and on another device, the time kept for hover', () => {
  assert.equal(cardLine({ state: 'answered', optionKind: 'allow' }, c).text, 'Allowed');
  assert.equal(cardLine({ state: 'answered', optionKind: 'deny', by: null }, c).text, 'Denied');
  assert.deepEqual(cardLine({ state: 'answered', optionKind: 'allow', by: { name: 'Pocket iPhone', at: 5 } }, c), {
    text: 'Allowed on Pocket iPhone',
    hover: 5,
    action: null,
  });
  assert.equal(cardLine({ state: 'answered', optionKind: 'deny', by: { name: 'Work MacBook Pro' } }, c).text, 'Denied on Work MacBook Pro');
  assert.equal(cardLine({ state: 'answered', optionKind: 'other' }, c).text, 'Answered');
});

test('lost the race names the device', () => {
  assert.equal(cardLine({ state: 'lost', by: { name: 'Work MacBook Pro', at: 9 } }, c).text, 'Already answered on Work MacBook Pro.');
});

test('expired, stopped, ended, restarted, moved, unreachable and managed', () => {
  assert.deepEqual(cardLine({ state: 'expired' }, c), { text: 'Not answered', action: null });
  assert.equal(cardLine({ state: 'stopped' }, c).text, 'Cancelled');
  assert.equal(cardLine({ state: 'turn_ended' }, c).text, 'Cancelled');
  assert.deepEqual(cardLine({ state: 'restarted' }, c), { text: 'The machine restarted', action: { kind: 'retry', label: 'Retry' } });
  assert.equal(cardLine({ state: 'moved' }, c).text, 'This chat moved to another machine.');
  assert.deepEqual(cardLine({ state: 'unreachable' }, c), {
    text: "Couldn't reach build-box.",
    action: { kind: 'try-again', label: 'Try again' },
  });
  assert.equal(cardLine({ state: 'unreachable' }, { now: 0 }).text, "Couldn't reach this machine.");
  assert.equal(cardLine({ state: 'policy' }, c).text, 'Managed by Acme');
  assert.equal(cardLine({ state: 'policy' }, { now: 0 }).text, 'Managed by your organization');
});

test('"Sent from" only for another client', () => {
  assert.equal(sentFrom('Pocket iPhone'), 'Sent from Pocket iPhone');
  assert.equal(sentFrom(null), null);
  assert.equal(sentFrom(undefined), null);
});
