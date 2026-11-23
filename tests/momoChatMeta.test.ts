// MoMo's tag on a chat (#2139): one predicate tells MoMo's chats, main writes the tag, and a window can never set or
// clear it (chats:patchMeta).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatsStore, registerChats } = require('../electron/platform/chats.cjs');
const { isMomoMeta, MOMO_META_KEY, shareableChatsIn } = require('../shared/momoChat.mjs');

test('isMomoMeta: only a non-empty momo tag marks a chat as MoMo’s', () => {
  assert.equal(MOMO_META_KEY, 'momo');
  for (const meta of [{ momo: 'main' }, { momo: 'previous' }]) assert.equal(isMomoMeta(meta), true);
  for (const meta of [null, undefined, 'momo', {}, { momo: null }, { momo: '' }, { momo: true }, { momo: 1 }])
    assert.equal(isMomoMeta(meta), false);
});

test('a window can’t set or clear MoMo’s tag; its other keys in the same patch still apply', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ChatsStore(path.join(dir, 'threads'), { legacyMirror: false });
  const h = new Map<string, any>();
  registerChats(
    { handle: (ch: string, f: any) => h.set(ch, f) },
    { store, uiState: path.join(dir, 'ui-state.json'), broadcast: () => undefined },
  );
  const e = { sender: 'w1' };
  assert.equal(h.get('chats:patchMeta')(e, 'c', { momo: 'main' }), false);
  assert.equal(store.records.has('c'), false);
  assert.equal(store.patchMeta('m', { momo: 'main' }), true);
  assert.equal(h.get('chats:patchMeta')(e, 'm', { momo: null, pinned: true }), true);
  assert.deepEqual([store.records.get('m').meta.momo, store.records.get('m').meta.pinned], ['main', true]);
  // the routine a MoMo background chat runs for (or the topic of one an older build made) is main's too
  assert.equal(store.patchMeta('r', { momo: 'routine', routineId: 'momo.r1', topicId: null }), true);
  assert.equal(h.get('chats:patchMeta')(e, 'r', { routineId: 'momo.r2', topicId: 'topic.x', unread: true }), true);
  assert.deepEqual(
    [store.records.get('r').meta.routineId, store.records.get('r').meta.topicId, store.records.get('r').meta.unread],
    ['momo.r1', null, true],
  );
  // a malformed patch is refused as before
  assert.equal(h.get('chats:patchMeta')(e, 'm', null), false);
});

test("shareableChatsIn fails closed: only a chat main knows that is not MoMo's may be shared", () => {
  const live: any = {};
  const shareable = shareableChatsIn(live);
  assert.equal(shareable('c'), false); // the chats store isn't there yet
  live.chats = {
    records: new Map<string, any>([
      ['m', { meta: { momo: 'main' } }],
      ['old', { meta: { momo: 'previous' } }],
      ['c', { meta: { pinned: true } }],
      ['bare', {}],
    ]),
  };
  assert.deepEqual(['m', 'old', 'c', 'bare', 'gone', ''].map(shareable), [false, false, true, true, false, false]);
});
