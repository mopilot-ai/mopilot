// Main's committed archive/delete retires preview ownership and continues clearing the chat's other browser resources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { savedPreview, url } from './support/dev-preview/restart.ts';
const require = createRequire(import.meta.url);
const { createAppState } = require('../electron/app/appState.cjs');
const { emptyRecord, segment } = require('../electron/platform/chatRecord.cjs');
const { flushPendingWrites } = require('../electron/platform/chats.cjs');

test('a committed archive with a failing recipe write still stops the preview and clears all later browser owners', async (t) => {
  const h = await savedPreview(t);
  const p = h.create({ probe: async () => false });
  p.waitReady = async () => 'ready';
  await p.prepare('chat', url);
  const server = p.list('chat')[0];
  const cleared: string[] = [];
  const live: any = {
    devPreviews: p,
    browserShim: { forget: () => cleared.push('shim') },
    hostTabs: { forget: () => cleared.push('tabs') },
    browserGrants: { forget: () => cleared.push('grants') },
    browserStorage: { endChat: async () => cleared.push('storage') },
  };
  const state = createAppState({
    app: { getPath: () => path.join(h.cwd, 'profile'), getVersion: () => '0.3.0' },
    isFlagEnabled: () => false,
    claude: { setChatNames() {}, retireChat() {} },
    live,
    broadcast() {},
  });
  state.openChats();
  state.chats.commit(emptyRecord('chat', [segment({ kind: 'codex', nativeId: 'native' })], 1));
  const original = p.saved.forget;
  p.saved.forget = () => {
    throw new Error('disk unavailable');
  };
  try {
    assert.doesNotThrow(() => state.chats.patchMeta('chat', { archived: 0 }));
    assert.equal(state.chats.record('chat').meta.archived, 0);
    assert.equal(server.live, false);
    assert.deepEqual(cleared, ['shim', 'tabs', 'grants', 'storage']);
    assert.equal(p.prepare('chat', url), null);
  } finally {
    p.saved.forget = original;
    flushPendingWrites();
  }
});
