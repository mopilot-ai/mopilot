// The line a closed card says, read by the Mac and the phone from the one journal item (shared/host/cardClosed.mjs): why it closed and who answered, in the words of cardLine.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedLine } from '../shared/host/cardClosed.mjs';

const now = 5_000;

test('each reason of a closed card has its words, and an answer names the device it came from', () => {
  assert.equal(closedLine({ reason: 'expired' }, { now }), 'Not answered');
  assert.equal(closedLine({ reason: 'stopped' }, { now }), 'Cancelled');
  assert.equal(closedLine({ reason: 'turn_ended' }, { now }), 'Cancelled');
  assert.equal(closedLine({ reason: 'host_restarted' }, { now }), 'The machine restarted');
  const by = { name: 'Pocket iPhone', fingerprint: 'ab12' };
  assert.equal(closedLine({ reason: 'answered', answeredBy: by, optionKind: 'allow' }, { now }), 'Allowed on Pocket iPhone');
  assert.equal(closedLine({ reason: 'answered', answeredBy: by, optionKind: 'deny', at: 1 }, { now }), 'Denied on Pocket iPhone');
  assert.equal(closedLine({ reason: 'answered', answeredBy: by, optionKind: 'other' }, { now }), 'Answered on Pocket iPhone');
  assert.equal(closedLine({ reason: 'answered', answeredBy: by }, { now }), 'Answered on Pocket iPhone');
});

test('a close an older Host sends without a reason, an answer from this device or from nowhere known, and an unknown reason say nothing', () => {
  assert.equal(closedLine({}, { now }), null);
  assert.equal(closedLine(null, { now }), null);
  assert.equal(closedLine({ reason: 'soon' }, { now }), null);
  const by = { name: 'Du MacBook', fingerprint: 'self' };
  assert.equal(closedLine({ reason: 'answered', answeredBy: by, optionKind: 'allow' }, { selfKey: 'self', now }), null);
  assert.equal(closedLine({ reason: 'answered', optionKind: 'allow' }, { now }), null);
  assert.equal(closedLine({ reason: 'answered', answeredBy: { name: '' }, optionKind: 'allow' }, { now }), null);
});
