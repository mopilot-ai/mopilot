// saveMeta: a patch the chat already holds is saved; only a patch that could not be written is a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { saveMeta, metaHolds } = createRequire(import.meta.url)('../shared/metaSave.mjs');

const store = (meta: any, o: { deleted?: boolean; accepts?: boolean } = {}) => {
  const calls: any[] = [];
  return {
    calls,
    records: new Map([['c', { meta }]]),
    isDeleted: () => o.deleted === true,
    patchMeta: (...a: any[]) => (calls.push(a), o.accepts !== false),
  };
};

test('a patch the chat already holds is a success without a write, undefined counting as null', () => {
  const s = store({ archived: null, config: { effort: 'medium' } });
  assert.equal(saveMeta(s, 'c', { config: { effort: 'medium' } }), true);
  assert.equal(saveMeta(s, 'c', { archived: undefined }), true);
  assert.equal(s.calls.length, 0);
});

test('a different value goes to the store, whose answer decides', () => {
  assert.equal(saveMeta(store({ config: { effort: 'low' } }), 'c', { config: { effort: 'high' } }), true);
  assert.equal(saveMeta(store({}, { accepts: false }), 'c', { pinned: true }), false);
});

test('nothing is held for a chat the store does not have, a deleted one, or a patch with no keys or a bad id', () => {
  assert.equal(metaHolds(store({}), 'other', { a: 1 }), false);
  assert.equal(metaHolds(store({ a: 1 }, { deleted: true }), 'c', { a: 1 }), false);
  assert.equal(metaHolds(store({ a: 1 }), 'c', {}), false);
  assert.equal(metaHolds(store({ a: 1 }), '', { a: 1 }), false);
  assert.equal(metaHolds(store({ a: 1 }), 'c', null), false);
});

test('against the real ChatsStore: the second identical effort save is a success though patchMeta says false', async (t) => {
  const { tmp } = await import('./support/chat-store-profile.ts');
  const { ChatsStore } = createRequire(import.meta.url)('../electron/platform/chats.cjs');
  const { threads } = tmp(t);
  const real = new ChatsStore(threads, { legacyMirror: false });
  real.ensure('3');
  const patch = { config: { effort: 'medium' } };
  assert.equal(saveMeta(real, '3', patch), true, 'first save writes');
  assert.equal(real.patchMeta('3', patch), false, 'the store itself calls an unchanged patch false');
  assert.equal(saveMeta(real, '3', patch), true, 'the repeat is still a success');
});
