// src/store/accounts.ts: a Codex API key entered anywhere (the welcome, Settings) goes through the checked path, so a
// key OpenAI rejects is refused when it is entered rather than at the first turn.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, bootImpls } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const accounts = (o: any = {}) => ({ active: null, autoSwitch: true, pool: 'spread', relay: false, login: null, accounts: [], ...o });

beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
});

test('the welcome’s Codex key is added like Settings’ key, and a rejected one says why', async () => {
  impl['accounts.addApiKey'] = async () => accounts({ active: 'k1' });
  await S.loginWithApiKey('sk');
  assert.deepEqual(callsOf('accounts.addApiKey'), [['sk', undefined, null]]);
  impl['accounts.addApiKey'] = () =>
    Promise.reject(new Error("Error invoking remote method 'accounts:addApiKey': Error: OpenAI rejected that API key"));
  await assert.rejects(S.loginWithApiKey('sk-bad'), /^Error: OpenAI rejected that API key$/);
});
