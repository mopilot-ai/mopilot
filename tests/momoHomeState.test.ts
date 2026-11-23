// The five states a client shows for MoMo's home (shared/momoHomeState.mjs): one derivation, in a fixed order of what outranks what.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { homeStateOf, ASLEEP_AFTER_MS } from '../shared/momoHomeState.mjs';

const ok = {
  kept: 'running' as 'none' | 'running' | 'moving',
  heardAt: 1000,
  now: 1000 + 5_000,
  reachable: true,
  current: true,
  signedIn: true,
};

test('no home has no state; a healthy running home is running', () => {
  assert.equal(homeStateOf({ ...ok, kept: 'none' }), null);
  assert.equal(homeStateOf(ok), 'running');
});

test('each failure reads as its own state, and the order is update, then away, then moving, then sign-in', () => {
  assert.equal(homeStateOf({ ...ok, current: false, reachable: false }), 'needs-update', 'an old Host is named before an unreachable one');
  assert.equal(homeStateOf({ ...ok, reachable: false }), 'asleep');
  assert.equal(homeStateOf({ ...ok, heardAt: null }), 'asleep', 'never heard this session');
  assert.equal(homeStateOf({ ...ok, now: 1000 + ASLEEP_AFTER_MS + 1 }), 'asleep');
  assert.equal(homeStateOf({ ...ok, now: 1000 + ASLEEP_AFTER_MS }), 'running', 'exactly on the limit is still awake');
  assert.equal(homeStateOf({ ...ok, kept: 'moving', signedIn: false }), 'moving');
  assert.equal(homeStateOf({ ...ok, signedIn: false }), 'needs-sign-in');
});
