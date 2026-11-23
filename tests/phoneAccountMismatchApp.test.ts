// In the app: a pairing code of another account is told at the scan, and signing out from that card leaves the account and closes the sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
const appPath = '../mobile/src/MobileApp';
const hintPath = '../mobile/src/accountHint';
const { MobileApp } = await import(appPath);
const { accountHint } = await import(hintPath);

const g = globalThis as any;
const base: any = {
  phase: 'ready',
  generation: 1,
  user: { id: 'user-1', email: 'ann@example.com' },
  pairs: [],
  presence: {},
  selectedPair: null,
  pendingPair: false,
  reconnect: null,
  outbox: [],
  pairingCommit: false,
  pairCleanup: false,
  safetyNumber: null,
  error: null,
};
const OTHER = JSON.stringify({
  v: 3,
  macId: 'mac-1',
  relay: 'wss://relay.example',
  code: 'AAAA',
  exp: 4102444800000,
  acct: accountHint('user-2'),
  who: 'b***@y.com',
});

test('the card for another account signs the phone out and closes the sheet, and nothing was paired', async () => {
  let listener = () => {};
  let state: any = base;
  const calls: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime: any = {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listener = fn;
      return () => {};
    },
    start: async () => {},
    request: async () => ({}),
    pair: async () => void calls.push('pair'),
    signOut: async () => {
      calls.push('signOut');
      state = { ...base, user: null };
    },
  };
  g.__phoneCamera = async () => ({ granted: true, canAskAgain: true, status: 'granted' });
  g.__setPasteButton(true);
  try {
    await act(async () => root.render(createElement(MobileApp, { runtime })));
    await flush();
    await click('Add a computer');
    g.__clipboardText = OTHER;
    await click('Paste');
    assert.match(host.textContent!, /This computer uses b\*\*\*@y\.com\. You're signed in as ann@example\.com\./);
    await click('Sign out and use b***@y.com');
    await act(async () => listener());
    await flush();
    assert.deepEqual(calls, ['signOut'], 'the account was left, and no pairing was tried');
    assert.doesNotMatch(host.textContent!, /This computer uses|Scan the code on your computer/, 'the sheet is closed');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
