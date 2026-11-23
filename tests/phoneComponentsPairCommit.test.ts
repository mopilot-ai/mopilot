// Accepted pairing writes show progress rather than offering actions that cannot cancel the commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const phoneModulePath = '../mobile/src/MobileApp';
const { MobileApp } = await import(phoneModulePath);

for (const pendingPair of [false, true]) {
  test(`pairing commit has no cleanup/cancel action with pending snapshot ${pendingPair}`, async () => {
    let listener = () => {};
    let state: any = {
      phase: 'pairing',
      generation: 1,
      user: { id: 'u' },
      pairs: [],
      selectedPair: null,
      pendingPair,
      presence: {},
      reconnect: null,
      outbox: [],
      pairingCommit: true,
      pairCleanup: false,
      safetyNumber: '123456',
      error: null,
    };
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
    };
    try {
      await act(async () => root.render(createElement(MobileApp, { runtime })));
      await flush();
      assert.match(host.textContent!, /Finishing pairing/);
      assert.doesNotMatch(host.textContent!, /Confirm on your computer|Cancel pairing|Remove unfinished pairing/);
      state = { ...state, phase: 'ready', pendingPair: false, pairingCommit: false };
      await act(async () => listener());
      assert.doesNotMatch(host.textContent!, /Finishing pairing/);
      assert.match(host.textContent!, /No computer of yours yet/);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
}
