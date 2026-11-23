// src/store/notifications.ts account/login/completed: the ChatGPT sign-in the welcome page waits on ends with its
// outcome said; one cancelled since (nothing waits on it any more) or replaced by a newer one ends quietly.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const note = (params: any) => (
  listeners['codex.onItem']({ kind: 'notification', chatId: null, method: 'account/login/completed', params }), mock.timers.tick(100)
);
const toasts = () => st().toasts.map((t) => [t.text, t.kind]);

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('the sign-in waited on ends: signed in, or why not, and the button is free again', () => {
  set({ loginPending: { loginId: 'l', authUrl: null } });
  note({ success: true, loginId: 'l' });
  assert.equal(st().loginPending, null);
  set({ loginPending: { loginId: 'l', authUrl: null } });
  note({ success: false, error: 'denied', loginId: 'l' });
  // an app-server that names no login ends the one waited on
  set({ loginPending: { loginId: 'l', authUrl: null } });
  note({ success: false });
  assert.equal(st().loginPending, null);
  assert.deepEqual(toasts(), [
    ['Signed in', 'info'],
    ['denied', 'error'],
    ['Sign in failed', 'error'],
  ]);
});

test('a sign-in cancelled since, or replaced by a newer one, ends quietly; the newer one still waits', () => {
  note({ success: false, error: 'cancelled', loginId: 'old' });
  set({ loginPending: { loginId: 'new', authUrl: 'https://auth/x' } });
  note({ success: false, error: 'cancelled', loginId: 'old' });
  assert.deepEqual(st().loginPending, { loginId: 'new', authUrl: 'https://auth/x' });
  assert.deepEqual(toasts(), []);
  // one that signed in anyway (it finished as Cancel was pressed) still says so
  set({ loginPending: null });
  note({ success: true, loginId: 'old' });
  assert.deepEqual(toasts(), [['Signed in', 'info']]);
});
