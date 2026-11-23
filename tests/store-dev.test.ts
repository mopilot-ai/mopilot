// src/store/devHooks.ts in Vite's dev server: automation hooks, and a hot update reloads the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf } from './support/store-harness.ts';

let accept: (() => void) | null = null;
const { store } = await loadStore({ dev: true, hot: { accept: (cb) => void (accept = cb) } });
const win = (globalThis as any).window;

test('dev builds expose the live store to automation and mark it loaded', () => {
  assert.equal(win.__codex.getState, store.getState);
  assert.equal(win.__codex.navigate, store.navigate);
  assert.equal(win.__sageStoreLoaded, true);
  assert.equal(callsOf('location.reload').length, 0);
});

test('a hot update of the store reloads the window', () => {
  accept!();
  assert.equal(callsOf('location.reload').length, 1);
});
