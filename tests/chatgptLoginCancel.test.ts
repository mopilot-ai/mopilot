// src/store/accounts.ts cancelChatgptLogin: a ChatGPT sign-in the user gave up on (a closed browser tab never answers)
// frees the welcome page's button at once, and the app-server's login is cancelled by its id; one with nothing to
// cancel, or whose cancel fails, still leaves the button free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, flush } from './support/store-harness.ts';

const { store: S } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { cancelChatgptLogin } = await import('../src/store/accounts.ts');
const cancels = () => callsOf('api.loginCancel');

test('cancelling a pending ChatGPT sign-in clears it and cancels that login in Codex', async () => {
  set({ loginPending: { loginId: 'L1', authUrl: 'https://auth/x' } } as any);
  await cancelChatgptLogin();
  assert.equal(st().loginPending, null);
  assert.deepEqual(cancels(), [['L1']]);
});

test('nothing pending cancels nothing; a cancel Codex refuses still frees the button', async () => {
  set({ loginPending: null } as any);
  await cancelChatgptLogin();
  assert.equal(cancels().length, 1);
  impl['api.loginCancel'] = async () => {
    throw new Error('already done');
  };
  set({ loginPending: { loginId: 'L2', authUrl: null } } as any);
  await cancelChatgptLogin();
  await flush();
  assert.equal(st().loginPending, null);
  assert.deepEqual(cancels(), [['L1'], ['L2']]);
});
