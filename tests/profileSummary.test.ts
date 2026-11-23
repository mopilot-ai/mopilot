// The sidebar account button's second line (src/harness/accounts.ts profileSummary): the plans in use, or a count.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { profileSummary } = await import('../src/harness/accounts.ts');

const acct = (id: string, extra: any = {}) =>
  ({ id, email: `${id}@x.dev`, plan: null, kind: 'subscription', status: 'ok', ...extra }) as any;

test('the plans of the accounts in use, in harness order; an account without a plan is named', () => {
  assert.equal(profileSummary([]), null);
  assert.equal(profileSummary([{ active: null, accounts: [] }]), null);
  assert.equal(
    profileSummary([
      { active: acct('c', { plan: 'Plus' }), accounts: [acct('c')] },
      { active: acct('a', { plan: 'Max' }), accounts: [acct('a')] },
    ]),
    'Plus · Max',
  );
  // signed in but its plan unknown: its name stands in
  assert.equal(profileSummary([{ active: acct('k'), accounts: [acct('k')] }]), 'k@x.dev');
  // accounts but none in use
  assert.equal(profileSummary([{ active: null, accounts: [acct('x')] }]), null);
});

test('more than two accounts read as a count', () => {
  assert.equal(
    profileSummary([
      { active: acct('a', { plan: 'Plus' }), accounts: [acct('a'), acct('b')] },
      { active: acct('c', { plan: 'Max' }), accounts: [acct('c')] },
    ]),
    '3 accounts',
  );
});

test('a signed-out login names no account and is not counted (a fresh Mac has a signed-out Claude Code login)', () => {
  const out = acct('default', { email: null, status: 'signin' });
  assert.equal(profileSummary([{ active: out, accounts: [out] }]), null);
  assert.equal(
    profileSummary([
      { active: acct('c', { plan: 'Plus' }), accounts: [acct('c'), acct('d')] },
      { active: out, accounts: [out] },
    ]),
    'Plus',
    'two signed-in accounts and a signed-out one: not "3 accounts"',
  );
  // an expired login is still the account it was
  assert.equal(profileSummary([{ active: acct('e', { plan: 'Max', status: 'expired' }), accounts: [] }]), 'Max');
});
