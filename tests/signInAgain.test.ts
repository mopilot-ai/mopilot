// src/store/accounts.ts: an expired account's toast offers "Sign in again", which reads the pool at the click: an
// account removed since is said, never signed in as a new one (#1988); main refuses it too (electron/identity/codexAccounts.cjs).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, flush } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { onAccountsEvent } = await import('../src/store/accounts.ts');
const { ACCOUNT_REMOVED } = await import('../src/store/liveAction.ts');
const accounts = (o: any = {}) => ({ active: null, autoSwitch: true, pool: 'spread', relay: false, login: null, accounts: [], ...o });

test('an expired account offers Sign in again, which re-verifies that account while it is in the pool', async () => {
  set({ toasts: [], accounts: accounts({ accounts: [{ id: 'acc', kind: 'chatgpt', status: 'expired' }] }) as any });
  impl['accounts.login'] = async () => accounts();
  onAccountsEvent({ type: 'event', kind: 'expired', email: null, id: 'acc' } as any);
  const [t] = st().toasts;
  assert.deepEqual([t.text, t.kind, t.action!.label], ['Sign-in expired for another account', 'error', 'Sign in again']);
  t.action!.run();
  await flush();
  assert.deepEqual(callsOf('accounts.login'), [['acc']]);
});

test('Sign in again on an account removed since the toast showed says so and signs nothing in', async () => {
  set({ toasts: [], accounts: accounts({ accounts: [{ id: 'acc', kind: 'chatgpt', status: 'expired' }] }) as any });
  onAccountsEvent({ type: 'event', kind: 'expired', email: 'a@x', id: 'acc' } as any);
  const run = st().toasts[0].action!.run;
  set({ accounts: accounts() as any });
  const logins = callsOf('accounts.login').length;
  run();
  await flush();
  assert.equal(callsOf('accounts.login').length, logins);
  assert.deepEqual(
    st()
      .toasts.slice(1)
      .map((t) => [t.text, t.kind]),
    [[ACCOUNT_REMOVED, 'error']],
  );
});
