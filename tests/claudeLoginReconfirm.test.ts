// An added Claude Code login whose config folder moved (electron/identity/contract/accountDirs.cjs) across the renderer: only a
// signed-out row is marked, and its status says it needs to be confirmed again instead of a bare Signed out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountStatusText, claudeAccounts } from '../src/harness/accounts.ts';

const st = (state: string) => ({ state, bin: '/x', version: null, plan: 'Claude Max', usage: null }) as any;
const login = (id: string, loggedIn: boolean, reconfirm?: boolean) => ({
  id,
  email: `${id}@example.com`,
  subscriptionType: 'max',
  organizationType: null,
  rateLimitTier: null,
  loggedIn,
  isDefault: id === 'default',
  ...(reconfirm === undefined ? {} : { reconfirm }),
});
const pool = (active: string, accounts: any[]) => ({ active, autoSwitch: true, login: null, accounts });

test('a signed-out login whose folder moved needs to be confirmed again; a plain sign-out stays Signed out', () => {
  const view = claudeAccounts(
    st('ready'),
    pool('default', [login('default', true), login('moved', false, true), login('out', false, false), login('old', false)]),
  );
  const [, moved, out, old] = view.accounts;
  assert.equal(moved.reconfirm, true);
  assert.deepEqual(accountStatusText(moved), { text: 'Needs to be confirmed again', tone: 'warn' });
  for (const a of [out, old]) {
    assert.equal('reconfirm' in a, false);
    assert.deepEqual(accountStatusText(a), { text: 'Signed out', tone: 'warn' });
  }
});

test('the login in use follows the harness status: marked only while that status reads signed out', () => {
  const accounts = [login('default', true), login('moved', false, true)];
  const signedOut = claudeAccounts(st('signin'), pool('moved', accounts)).active!;
  assert.equal(signedOut.reconfirm, true);
  assert.equal(accountStatusText(signedOut).text, 'Needs to be confirmed again');
  // the harness reads it signed in (the account list is older): nothing to confirm
  const working = claudeAccounts(st('ready'), pool('moved', accounts)).active!;
  assert.equal('reconfirm' in working, false);
  assert.equal(working.status, 'ok');
});
