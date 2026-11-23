// Claude Code's account list when its CLI login was never signed in (#1867): no account, as Codex shows it, while
// signed out, being checked or failing; a login once signed in (an email, a plan, a moved folder) keeps its row.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { claudeAccounts } = await import('../src/harness/accounts.ts');

const claudeRow = (id: string, email: string | null, loggedIn = true, sub: string | null = 'pro') => ({
  id,
  email,
  subscriptionType: sub,
  organizationType: null,
  rateLimitTier: null,
  loggedIn,
  isDefault: id === 'default',
});

test('Claude Code: a login nobody signed in to is no account, as with Codex (#1867)', () => {
  const st = { state: 'signin', bin: '/x', version: null, plan: null, email: null, usage: null } as any;
  const never = claudeRow('default', null, false, null);
  const pool = { active: 'default', autoSwitch: true, login: null, accounts: [never] };
  const r = claudeAccounts(st, pool, {});
  assert.equal(r.active, null);
  assert.equal(r.accounts.length, 0);
  // one that was signed in and lapsed keeps its row, to sign in again
  const lapsed = claudeAccounts({ ...st, email: 'a@example.com' }, pool, {});
  assert.equal(lapsed.active?.status, 'signin');
  const known = claudeAccounts(st, { ...pool, accounts: [{ ...never, subscriptionType: 'max' }] }, {});
  assert.equal(known.active?.status, 'signin');
  const moved = claudeAccounts(st, { ...pool, accounts: [{ ...never, reconfirm: true }] }, {});
  assert.equal(moved.active?.status, 'signin');
  // still being checked, or failing, it is no one yet either
  for (const state of ['detecting', 'error']) assert.equal(claudeAccounts({ ...st, state }, pool, {}).active, null, state);
  assert.equal(
    claudeAccounts({ ...st, state: 'detecting' }, { ...pool, accounts: [{ ...never, loggedIn: true }] }, {}).active?.id,
    'default',
  );
  // an added login beside it stays listed
  const added = claudeAccounts(st, { ...pool, accounts: [never, claudeRow('b1', 'b@example.com')] }, {});
  assert.deepEqual(
    added.accounts.map((a) => a.id),
    ['b1'],
  );
  assert.equal(added.active, null);
});
