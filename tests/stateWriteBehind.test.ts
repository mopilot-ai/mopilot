// ui-state.json and the legacy mirror are derived state, held in memory and written behind (platform/uiStateFile.cjs, writeBehind.cjs); a chat's record stays on the disk before its change is acknowledged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp } from './support/chat-store-profile.ts';

const require = createRequire(import.meta.url);
const chats = require('../electron/platform/chats.cjs');
const { ChatsStore, registerChats, patchPrefs, writeRendererState, flushPendingWrites } = chats;
const { createUiStateFiles } = require('../electron/platform/uiStateFile.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');
const { readStateFile } = require('../electron/platform/fsutil.cjs');
const { WriteBehind } = require('../electron/platform/writeBehind.cjs');

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('a chat change is on the disk, compact, before it is acknowledged; its mirror follows behind', (t) => {
  const { threads, ui: file } = tmp(t);
  const store = new ChatsStore(threads, { uiState: file });
  for (let i = 0; i < 20; i++) assert.equal(store.patchMeta('c', { account: `t${i}` }), true);
  const text = fs.readFileSync(store.file('c'), 'utf8');
  assert.equal(text.includes('\n'), false);
  assert.equal(JSON.parse(text).meta.account, 't19');
  assert.equal(store.saved('c'), true);
  // the mirror for older builds is made once, when it is written
  assert.equal(fs.existsSync(file), false);
  flushPendingWrites();
  assert.deepEqual(read(file).claudeChats, { c: 't19' });
});

test('a deleted chat is not brought back by a mirror change still waiting to be written', (t) => {
  const { threads } = tmp(t);
  const store = new ChatsStore(threads);
  store.commit({
    id: 'gone',
    segments: [
      { kind: 'codex', nativeId: 'a' },
      { kind: 'claude', nativeId: 'b' },
    ],
    meta: {},
  });
  store.isDeleted = () => true;
  assert.equal(store.forgetDeleted('gone'), true);
  flushPendingWrites();
  assert.equal(fs.existsSync(store.legacyFile('gone')), false);
  assert.equal(fs.existsSync(store.file('gone')), false);
});

test('in fallback the legacy files are the only copy, and are on the disk when the change returns', (t) => {
  const { threads, ui: file } = tmp(t);
  const store = new ChatsStore(threads, { uiState: file, fallback: true });
  store.commit({
    id: 'c',
    segments: [
      { kind: 'codex', nativeId: 'a' },
      { kind: 'claude', nativeId: 'b' },
    ],
    meta: { pinned: true },
  });
  assert.equal(read(store.legacyFile('c')).id, 'c');
  assert.deepEqual(read(file).pinned, { c: true });
});

test('prefs and the windows state are read back at once and written behind in one compact file', (t) => {
  const { threads, ui: file } = tmp(t);
  const store = new ChatsStore(threads, { uiState: file });
  patchPrefs(file, { a: 1 });
  patchPrefs(file, { b: 2 }, ['a']);
  writeRendererState(file, { sidebar: { open: true }, prefs: { ignored: true } });
  store.patchMeta('p', { pinned: true });
  store.patchMeta('q', { unread: true });
  assert.deepEqual(chats.readUiState(file).prefs, { b: 2 });
  assert.deepEqual(chats.peekUiState(file).prefs, { b: 2 });
  assert.equal(fs.existsSync(file), false);
  flushPendingWrites();
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes('\n'), false);
  const saved = JSON.parse(text);
  assert.deepEqual(saved.prefs, { b: 2 });
  assert.deepEqual(saved.sidebar, { open: true });
  assert.deepEqual(saved.pinned, { p: true });
  assert.deepEqual(saved.unread, { q: true });
});

test('two windows combine: each change lands on what main holds', (t) => {
  const { threads, ui: file } = tmp(t);
  const store = new ChatsStore(threads, { uiState: file });
  const handlers = new Map<string, any>();
  registerChats({ handle: (c: string, f: any) => handlers.set(c, f) }, { store, uiState: file, broadcast: () => {} });
  assert.equal(handlers.get('prefs:patch')({ sender: 'A' }, { fromA: 1 }, []), true);
  assert.equal(handlers.get('prefs:patch')({ sender: 'B' }, { fromB: 2 }, []), true);
  assert.equal(handlers.get('chats:patchMeta')({}, 'c', { pinned: true }), true);
  assert.equal(handlers.get('chats:patchMeta')({}, 'c', { unread: true }), true);
  flushPendingWrites();
  assert.deepEqual(read(file).prefs, { fromA: 1, fromB: 2 });
  const record = read(store.file('c'));
  assert.equal(record.meta.pinned && record.meta.unread, true);
});

test('a file something else replaced is read again, and a write waiting under the replacement is applied to it', (t) => {
  const { ui: file } = tmp(t);
  assert.deepEqual(chats.peekUiState(file), {});
  fs.writeFileSync(file, JSON.stringify({ prefs: { x: 1 } }));
  assert.deepEqual(chats.peekUiState(file).prefs, { x: 1 });
  fs.writeFileSync(file, JSON.stringify({ prefs: { x: 2, longer: 'value' } }));
  assert.equal(chats.readUiState(file).prefs.x, 2);
  assert.equal(chats.inspectUiState(file).prefs.x, 2);
  // main's own change is waiting when the file is replaced (a migration, another launch): the change lands on the new file
  flushPendingWrites();
  patchPrefs(file, { y: 3 });
  fs.writeFileSync(file, JSON.stringify({ prefs: { other: true, padding: 'to change the size' }, fromElsewhere: 1 }));
  assert.equal(chats.readUiState(file).prefs.y, 3);
  flushPendingWrites();
  assert.deepEqual(read(file), { prefs: { other: true, padding: 'to change the size', y: 3 }, fromElsewhere: 1 });
  // a replacement that cannot be read leaves the held state to be written
  patchPrefs(file, { z: 4 });
  fs.writeFileSync(file, '{torn');
  flushPendingWrites();
  assert.deepEqual(read(file).prefs, { other: true, padding: 'to change the size', y: 3, z: 4 });
  // an unreadable file reads as nothing for a looker, and a root that is not a record is shown as it is
  fs.writeFileSync(file, '{torn');
  assert.deepEqual(chats.peekUiState(file), {});
  assert.throws(() => chats.inspectUiState(file));
  fs.writeFileSync(file, '[1]');
  assert.deepEqual(chats.inspectUiState(file), [1]);
  fs.rmSync(file);
  assert.deepEqual(chats.inspectUiState(file), {});
  // dropping what is held writes it first
  patchPrefs(file, { w: 5 });
  chats.dropUiState(file);
  assert.equal(read(file).prefs.w, 5);
  chats.touchUiState(path.join(path.dirname(file), 'not-held.json'));
});

test('changes that cannot be written pile up only so far: past that they are kept as the state they made', (t) => {
  const { ui: file } = tmp(t);
  for (let i = 0; i < 130; i++) patchPrefs(file, { [`k${i}`]: i });
  fs.writeFileSync(file, JSON.stringify({ prefs: {}, padding: 'replaced' }));
  flushPendingWrites();
  assert.equal(read(file).prefs.k129, 129);
});

test('the legacy keys follow the switch when the file is written, and a newer build’s file is left as it is', (t) => {
  const { threads, ui: file } = tmp(t);
  let on = true;
  const store = new ChatsStore(threads, { uiState: file, legacyMirror: () => on });
  store.patchMeta('p', { pinned: true });
  on = false;
  flushPendingWrites();
  // switched off before the write: no keys were made
  assert.equal(read(file).pinned, undefined);
  on = true;
  store.patchMeta('r', { pinned: true });
  flushPendingWrites();
  fs.writeFileSync(file, JSON.stringify({ stateVersion: 1e9, pinned: { old: true } }));
  assert.equal(chats.readUiState(file).stateVersion, 1e9);
  chats.touchUiState(file);
  flushPendingWrites();
  assert.deepEqual(read(file).pinned, { old: true });
  // a store with no ui-state file has nothing to release
  new ChatsStore(threads).releaseUiState();
  store.releaseUiState();
});

test('a file that keeps failing to save with nobody to tell is only logged', (t) => {
  const { ui: file } = tmp(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (to === file) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => logged.push(a));
  patchPrefs(file, { a: 1 });
  for (let i = 0; i < 6; i++) flushPendingWrites();
  assert.equal(logged.length, 1);
  chats.dropUiState(file);
});

test('a file that keeps failing to save is shown once through the notice main sets', (t) => {
  const { ui: file } = tmp(t);
  // the disk refuses the file (full, read-only)
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (to === file) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    return rename(from, to);
  });
  const shown: string[] = [];
  const error = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = error;
    chats.setSaveFailureNotice(() => {});
    chats.dropUiState(file);
  });
  chats.setSaveFailureNotice((f: string) => shown.push(f));
  clearIgnored();
  patchPrefs(file, { a: 1 });
  for (let i = 0; i < 6; i++) flushPendingWrites();
  assert.deepEqual(shown, [file]);
  assert.ok(recentIgnored().length > 0);
});

test('the held state works with any writer handed in', (t) => {
  const { ui: file } = tmp(t);
  const writes: string[] = [];
  const writer = new WriteBehind({
    writeAsync: async () => true,
    writeSync: (f: string, data: string) => writes.push(data),
    remove: () => {},
    fs,
    note: () => {},
    failed: () => {},
  });
  const files = createUiStateFiles({ writer, readStateFile });
  files.updateUiState(file, (s: any) => ({ ...s, a: 1 }));
  writer.flushSync();
  assert.deepEqual(writes, ['{"a":1}']);
});
