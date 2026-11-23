// Where an account stands in MoMo's brain lists, setup's and Settings' alike (src/components/momo/settings/perUse.ts,
// #2281): offered when a brain can run on it now, listed at its limit with its state, left out when billed per use,
// signed out or unconfirmed; and the words both lists say its state in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainAccountState, brainAccountUse } from '../src/components/momo/settings/perUse.ts';

const row = (state: string, o: { kind?: string; plan?: string | null } = {}) => ({
  account: { kind: o.kind ?? 'subscription' },
  plan: o.plan ?? null,
  state,
});

test('an account’s place in a brain list, in every state', () => {
  assert.equal(brainAccountUse(row('signed-in')), 'offered');
  assert.equal(brainAccountUse(row('checking')), 'offered');
  assert.equal(brainAccountUse(row('limited')), 'at-limit');
  for (const state of ['lapsed', 'unverified', 'billed']) assert.equal(brainAccountUse(row(state)), null, state);
  assert.equal(brainAccountUse(row('limited', { kind: 'apiKey' })), null, 'a key at its limit still bills per use');
  assert.equal(brainAccountUse(row('signed-in', { plan: 'MoPilot credits' })), null);
});

test('its state in words: plan and full status, either left out when empty', () => {
  assert.equal(
    brainAccountState({ plan: 'Max', status: { text: 'Limit reached · resets Oct 25' } }),
    'Max · Limit reached · resets Oct 25',
  );
  assert.equal(brainAccountState({ plan: null, status: { text: 'Limit reached' } }), 'Limit reached');
  assert.equal(brainAccountState({ plan: 'Pro', status: { text: '' } }), 'Pro');
});
