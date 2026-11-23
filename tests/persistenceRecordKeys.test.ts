// Opaque record keys survive renderer deltas, main-process snapshots and legacy chat-state migration.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPrefsDelta, chatChanges, mapsFromSnapshot, prefsDelta } from '../src/lib/chatMeta.ts';
const require = createRequire(import.meta.url);
const { ChatsStore } = require('../electron/platform/chats.cjs');
const chatRecord = require('../electron/platform/chatRecord.cjs');
const ids = ['__proto__', 'constructor', 'toString', 'claude:opaque', 'acp:goose:opaque', 'quoted"\\\n'];

test('chat deltas add and remove own keys without mutating inherited prototypes', () => {
  const initial = mapsFromSnapshot(null);
  for (const id of ids) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'pinned');
    try {
      const next = { ...initial, pinned: { [id]: true }, segments: { [id]: [] } };
      const added = chatChanges(initial, next);
      assert.equal(Object.hasOwn(added.meta, id), true);
      assert.deepEqual(added.meta[id], { pinned: true });
      assert.equal(Object.hasOwn(added.segments, id), true);
      assert.deepEqual(added.segments[id], []);
      assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'pinned'), descriptor);
      const removed = chatChanges(next, initial);
      assert.deepEqual(removed.meta[id], { pinned: false });
      assert.equal(Object.hasOwn(removed.segments, id), true);
      assert.equal(removed.segments[id], null);
    } finally {
      if (descriptor) Object.defineProperty(Object.prototype, 'pinned', descriptor);
      else Reflect.deleteProperty(Object.prototype, 'pinned');
    }
  }
});

test('prefs deltas preserve prototype-like set keys and remove them when absent', () => {
  const next = Object.fromEntries(ids.map((id) => [id, {}]));
  const added = prefsDelta({}, next);
  assert.deepEqual(added.set, next);
  assert.deepEqual(applyPrefsDelta({}, added), next);
  const removed = prefsDelta(next, {});
  assert.deepEqual(removed.unset.toSorted(), ids.toSorted());
  assert.deepEqual(applyPrefsDelta(next, removed), {});
});

test('accepted chat ids remain own keys in snapshots and legacy mirrors after reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-record-keys-'));
  try {
    const threads = path.join(dir, 'threads');
    const uiState = path.join(dir, 'ui-state.json');
    const store = new ChatsStore(threads, { uiState });
    for (const id of ids) {
      assert.equal(store.ensure(id), true);
      assert.equal(
        store.patchMeta(id, { pinned: true, unread: true, worktreeOf: '/work', archived: 1, account: { id: 'account', pinned: true } }),
        true,
      );
    }
    const reloaded = new ChatsStore(threads, { uiState });
    const snapshot = reloaded.snapshot();
    assert.deepEqual(Object.keys(snapshot.chats).toSorted(), ids.toSorted());
    for (const id of ids) assert.equal(Object.hasOwn(snapshot.chats, id), true);
    const legacy = JSON.parse(fs.readFileSync(uiState, 'utf8'));
    for (const key of ['pinned', 'unread', 'worktreeOf', 'claudeArchived', 'claudeChats'])
      assert.deepEqual(Object.keys(legacy[key]).toSorted(), ids.filter((id) => !id.startsWith('acp:')).toSorted());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy chat files retain opaque owners without inheriting absent pinned or unread values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-legacy-record-keys-'));
  try {
    const threads = path.join(dir, 'threads');
    fs.mkdirSync(threads);
    for (const id of ids)
      fs.writeFileSync(
        path.join(threads, encodeURIComponent(id) + '.json'),
        JSON.stringify({ id, segments: [{ harness: 'codex', nativeId: id }] }),
      );
    const records = chatRecord.legacyRecords(dir, 10);
    assert.deepEqual(records.map((r: { id: string }) => r.id).toSorted(), ids.toSorted());
    for (const record of records) {
      assert.equal(record.meta.pinned, false);
      assert.equal(record.meta.unread, false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fallback preserves unreadable opaque-owner metadata when another chat changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-fallback-record-keys-'));
  try {
    const threads = path.join(dir, 'threads');
    fs.mkdirSync(threads);
    const uiState = path.join(dir, 'ui-state.json');
    const original = { pinned: { ['__proto__']: true }, claudeChats: { ['__proto__']: { id: 'saved-account', pinned: true } } };
    fs.writeFileSync(uiState, JSON.stringify(original));
    const damagedFile = path.join(threads, '__proto__.json');
    const damaged = JSON.stringify({ id: 'different-owner', segments: [] });
    fs.writeFileSync(damagedFile, damaged);
    const store = new ChatsStore(threads, { uiState, fallback: true });
    assert.equal(store.patchMeta('healthy', { pinned: true }), true);
    const saved = JSON.parse(fs.readFileSync(uiState, 'utf8'));
    assert.deepEqual(saved.pinned, { ['__proto__']: true, healthy: true });
    assert.deepEqual(saved.claudeChats, original.claudeChats);
    assert.deepEqual(saved.unread, {});
    assert.equal(fs.readFileSync(damagedFile, 'utf8'), damaged);
    const reloaded = new ChatsStore(threads, { uiState, fallback: true });
    assert.equal(reloaded.patchMeta('healthy', { unread: true }), true);
    const again = JSON.parse(fs.readFileSync(uiState, 'utf8'));
    assert.deepEqual(again.pinned, saved.pinned);
    assert.deepEqual(again.claudeChats, original.claudeChats);
    assert.deepEqual(again.unread, { healthy: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
