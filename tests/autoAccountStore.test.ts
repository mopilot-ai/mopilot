// Renderer reconciliation after main applies an automatic account switch.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, bootImpls, flush, listeners } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store } = await loadStore();

test('the window follows main account snapshots and a delayed switch event cannot erase a newer pin', async () => {
  bootImpls();
  await store.boot();
  await flush();
  listeners['chats.onChanged']({ id: 'c', chat: { kind: 'claude', meta: { account: null } } });
  assert.equal(store.useStore.getState().claudeChats.c, undefined);
  listeners['chats.onChanged']({ id: 'c', chat: { kind: 'claude', meta: { account: { id: 'new', pinned: true } } } });
  listeners['codex.onItem']({
    kind: 'switched',
    chatId: 'c',
    harness: 'claude',
    key: 'k',
    model: 'opus',
    fresh: false,
  });
  mock.timers.tick(100);
  assert.deepEqual(store.useStore.getState().claudeChats.c, { id: 'new', pinned: true });
});
