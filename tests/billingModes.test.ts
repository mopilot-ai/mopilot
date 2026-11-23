// The picker's billing switch: which modes a harness can move to (D-81).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingOptions } from '../src/lib/billingModes.ts';

test('credits join the other ways to pay once they are set up', () => {
  assert.deepEqual(billingOptions('subscription', { subscription: true, apiKey: true, credits: true }), ['apiKey', 'mopilot']);
  assert.deepEqual(billingOptions('subscription', { subscription: true, apiKey: false, credits: true }), ['mopilot']);
  assert.deepEqual(billingOptions('subscription', { subscription: true, apiKey: false, credits: false }), []);
  assert.deepEqual(billingOptions('apiKey', { subscription: true, apiKey: true, credits: true }), ['subscription', 'mopilot']);
  assert.deepEqual(billingOptions('mopilot', { subscription: true, apiKey: true, credits: true }), ['subscription', 'apiKey']);
  // a subscription that is signed out is not an option to move to
  assert.deepEqual(billingOptions('mopilot', { subscription: false, apiKey: true, credits: true }), ['apiKey']);
});
