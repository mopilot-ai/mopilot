import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, bootImpls, flush, calls } from './support/store-harness.ts';

// The real store, booted as a Quick Chat window: its settings links go to the main app.
const { store } = await loadStore();

test('Quick Chat settings links open the main app without replacing the floating conversation', async () => {
  bootImpls();
  await store.boot({ quickChat: true });
  const route = JSON.stringify(store.useStore.getState().route);
  calls.length = 0;
  impl['win.quickChatSettings'] = async () => ({ ok: true });
  store.navigate({ name: 'settings', section: 'harnesses' } as any);
  store.navigate({ name: 'settings', section: 'accounts' } as any);
  await flush();
  assert.deepEqual(
    callsOf('win.quickChatSettings').map((a) => a[0]),
    ['harnesses', 'accounts'],
  );
  assert.equal(JSON.stringify(store.useStore.getState().route), route);
});
