// The cloud machine line (X6): every lifecycle state of C1 and C2 has its line, dot and action from the plan's table, in the plan's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudLine, CREATE_WORDS, hoursRunWords, WAKES_WHEN_YOU_START } from '../shared/cloud/cloudLine.mjs';

test('each state reads as the plan says, and the first that matches wins', () => {
  assert.deepEqual(cloudLine({ gone: true, creating: 'create', waking: true, asleep: true }), {
    line: 'Deleted at the provider',
    dot: 'off',
    action: 'Remove',
  });
  assert.deepEqual(cloudLine({ creating: 'create' }), { line: 'Creating…', dot: 'warn', action: 'Cancel' });
  assert.equal(cloudLine({ creating: 'start' })?.line, 'Setting up…');
  assert.equal(cloudLine({ creating: 'connect' })?.line, 'Connecting…');
  assert.equal(cloudLine({ creating: 'pair' })?.line, 'Connecting…');
  assert.deepEqual(cloudLine({ waking: true, asleep: true }), { line: 'Waking…', dot: 'warn', action: null });
  assert.deepEqual(cloudLine({ asleep: true, canWake: true }), { line: 'Asleep · wakes on next message', dot: 'off', action: 'Wake' });
  assert.deepEqual(cloudLine({ asleep: true }), { line: 'Asleep · wake it from your Mac', dot: 'off', action: null });
  assert.deepEqual(cloudLine({ stopping: true }), { line: 'Stopping · idle', dot: 'warn', action: null });
  assert.equal(cloudLine({}), null);
  assert.deepEqual(Object.keys(CREATE_WORDS), ['create', 'start', 'connect', 'pair']);
});

test('the hours words and the phone row words', () => {
  assert.equal(hoursRunWords('dev-cloud', 9), 'dev-cloud has run 9 hours');
  assert.equal(hoursRunWords('dev-cloud', 0.6), 'dev-cloud has run 1 hour');
  assert.equal(WAKES_WHEN_YOU_START, 'Wakes when you start');
});
