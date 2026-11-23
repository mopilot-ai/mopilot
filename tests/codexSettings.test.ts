// A Codex chat's own model, effort and Fast (src/harness/codexSettings.ts, electron/harness/codex.cjs
// chatPrefs), and the chat config map in the per-chat meta (src/lib/chatMeta.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { codexChatSelection } from '../src/harness/codexSettings.ts';
import { applyChat, chatChanges, mapsFromSnapshot } from '../src/lib/chatMeta.ts';

const require = createRequire(import.meta.url);
const { chatPrefs } = require('../electron/harness/codex.cjs');

const prefs = { model: 'm1', effort: 'medium', serviceTier: null };

test("D-29: a chat's own settings win, key by key; a chat with none uses the defaults", () => {
  assert.deepEqual(codexChatSelection(prefs, null), prefs);
  assert.deepEqual(codexChatSelection(prefs, { model: 'm2' }), { model: 'm2', effort: 'medium', serviceTier: null });
  // "Reset to default" in a chat is null there, not the global default
  assert.deepEqual(codexChatSelection(prefs, { model: null, effort: null, serviceTier: 'priority' }), {
    model: null,
    effort: null,
    serviceTier: 'priority',
  });
  // main reads the same rule for the turn it sends
  assert.deepEqual(chatPrefs({ ...prefs, permission: 'default' }, { effort: 'high' }), {
    model: 'm1',
    effort: 'high',
    serviceTier: null,
    permission: 'default',
  });
  assert.deepEqual(chatPrefs({ ...prefs }, null), prefs);
});

test("the chat config map goes to and comes from the chat's meta.config", () => {
  const prev = mapsFromSnapshot({ chats: {}, newer: [] });
  const next = { ...prev, chatConfig: { t1: { model: 'm2' } } };
  // the keys the window changed; main merges them onto the chat's config (electron/platform/windowMetaPatch.cjs)
  assert.deepEqual(chatChanges(prev, next).meta, { t1: { configKeys: { set: { model: 'm2' }, unset: [] } } });
  const maps = applyChat(prev, 't2', { segments: null, meta: { config: { effort: 'high' } } as any });
  assert.deepEqual(maps.chatConfig, { t2: { effort: 'high' } });
});
