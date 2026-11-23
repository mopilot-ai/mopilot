// src/store/devHooks.ts loaded a second time in one dev page (a hot update under a new URL): it reloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf } from './support/store-harness.ts';

(globalThis as any).window.__sageStoreLoaded = true;
await loadStore({ dev: true });

test('a second store instance in the same page reloads instead of binding the UI to it', () => {
  assert.equal(callsOf('location.reload').length, 1);
});
