// A Codex chat's account pin in the window store (src/store/accounts.ts): keyed through the chat's Codex
// thread, whatever segment it is on now (R-5), and carried to a fork or side chat (R-3).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const accounts = (o: any = {}) => ({ active: null, autoSwitch: true, pool: 'spread', relay: false, login: null, accounts: [], ...o });

beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
});

test("a Codex pin goes on the chat's Codex thread; a chat never on Codex has none yet; forks keep a pin", async () => {
  impl['accounts.pinChat'] = async () => accounts({ active: 'pin' });
  set({ accounts: accounts(), segments: { c: [{ nativeId: 'n', harness: 'codex', start: 0 }] as any } });
  await S.pinCodexChat('c', 'a1');
  assert.equal(st().accounts.active, 'pin');
  // on Claude Code now: the pin is still the chat's Codex thread's, never the Claude session's (R-5)
  set({
    segments: {
      c: [
        { nativeId: 'n', harness: 'codex', start: 0 },
        { nativeId: 'claude:s', harness: 'claude', start: 1 },
      ] as any,
    },
  });
  await S.pinCodexChat('c', 'a2');
  // never on Codex: nothing to pin until a switch makes its thread
  set({ segments: { k: [{ nativeId: 'claude:k', harness: 'claude', start: 0 }] as any } });
  await S.pinCodexChat('k', 'a3');
  await S.pinCodexChat('acp:kimi:1', 'a3');
  assert.deepEqual(callsOf('accounts.pinChat'), [
    ['n', 'a1'],
    ['n', 'a2'],
  ]);
  // a fork or side chat of a pinned chat gets the pin on its own thread; an automatic one is left to the pool (R-3)
  set({
    segments: {},
    accounts: { ...st().accounts, chatAccounts: { p: { id: 'b', pinned: true }, q: { id: 'b', pinned: false } } },
  });
  await S.inheritCodexPin('p', 'fork-1');
  await S.inheritCodexPin('q', 'fork-2');
  await S.inheritCodexPin('none', 'fork-3');
  set({ segments: { k: [{ nativeId: 'claude:k', harness: 'claude', start: 0 }] as any } });
  await S.inheritCodexPin('k', 'fork-4');
  assert.deepEqual(callsOf('accounts.pinChat').slice(2), [['fork-1', 'b']]);
});
