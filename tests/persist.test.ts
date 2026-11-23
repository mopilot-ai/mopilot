// Per-chat v2 files and prefs, owned by main (electron/platform/chats.cjs), and the deltas windows
// send them (src/lib/chatMeta.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyChat, applyPrefsDelta, chatChanges, mapsFromSnapshot, prefsDelta } from '../src/lib/chatMeta.ts';

const require = createRequire(import.meta.url);
const { writeAtomic } = require('../electron/platform/fsutil.cjs');
const { ChatsStore, patchPrefs, writeRendererState, flushPendingWrites } = require('../electron/platform/chats.cjs');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-persist-')));
function setup() {
  const dir = tmp();
  const ui = path.join(dir, 'ui-state.json');
  fs.writeFileSync(ui, JSON.stringify({ prefs: { theme: 'dark', model: 'a' }, sidebarOpen: true }));
  return { dir, ui, threads: path.join(dir, 'threads') };
}
// what main holds in memory is written behind: read the files once it is on the disk
const json = (f: string) => (flushPendingWrites(), JSON.parse(fs.readFileSync(f, 'utf8')));

test('writeAtomic: a crash before the rename leaves the old file whole and no temp file behind', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.json');
  writeAtomic(file, '{"v":1}');
  const realRename = fs.renameSync;
  (fs as any).renameSync = () => {
    throw new Error('killed');
  };
  try {
    assert.throws(() => writeAtomic(file, '{"v":2}'), /killed/);
  } finally {
    (fs as any).renameSync = realRename;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":1}');
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
  writeAtomic(file, '{"v":3}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":3}');
});

test('a chat file is created lazily on its first change, one file per chat', () => {
  const { threads, ui } = setup();
  const store = new ChatsStore(threads, { uiState: ui, now: () => 5 });
  assert.equal(store.patchMeta('cx-1', { pinned: false }), false, 'nothing to record');
  assert.ok(!fs.existsSync(threads));
  assert.equal(store.patchMeta('cx-1', { pinned: true, bogus: 1 }), true);
  const rec = json(path.join(threads, 'cx-1.v2'));
  assert.equal(rec.schemaVersion, 2);
  assert.deepEqual(
    rec.segments.map((s: any) => [s.kind, s.nativeId]),
    [['codex', 'cx-1']],
  );
  assert.equal(rec.meta.pinned, true);
  assert.ok(!('bogus' in rec.meta));
  assert.equal(store.patchMeta('claude:s', { archived: 7 }), true);
  assert.deepEqual(json(path.join(threads, 'claude%3As.v2')).segments[0].kind, 'claude');
  assert.deepEqual(fs.readdirSync(threads).sort(), ['claude%3As.v2', 'cx-1.v2']);
  // the renderer is told each chat's owner from its record
  assert.equal(store.get('claude:s').kind, 'claude');
  assert.equal(store.get('cx-1').kind, 'codex');
});

test('meta patches merge per key and reload from disk', () => {
  const { threads, ui } = setup();
  const a = new ChatsStore(threads, { uiState: ui });
  a.patchMeta('cx-1', { pinned: true });
  a.patchMeta('cx-1', { unread: true, worktreeOf: '/w' });
  a.patchMeta('cx-1', { worktreeOf: null });
  const m = new ChatsStore(threads, { uiState: ui }).snapshot().chats['cx-1'].meta;
  assert.deepEqual([m.pinned, m.unread, m.worktreeOf], [true, true, null]);
});

test('segments round-trip in the renderer shape; single-segment chats show none', () => {
  const { threads, ui } = setup();
  const store = new ChatsStore(threads, { uiState: ui });
  const segs = [
    { harness: 'codex', nativeId: 'cx-1', start: 0, count: 2, model: null, handoff: null },
    { harness: 'claude', nativeId: 'claude:s-2', start: 2, count: null, model: 'sonnet', handoff: { mode: 'auto', tokens: 3, text: 'h' } },
  ];
  store.setSegments('cx-1', segs);
  assert.deepEqual(new ChatsStore(threads, { uiState: ui }).get('cx-1').segments, segs);
  store.setSegments('cx-1', null);
  assert.equal(store.get('cx-1').segments, null);
  assert.equal(json(path.join(threads, 'cx-1.v2')).segments.length, 1);
  // the legacy file is a derived copy for older builds, written behind
  flushPendingWrites();
  assert.ok(!fs.existsSync(path.join(threads, 'cx-1.json')), 'the legacy file goes with the switch');
});

test('a chat file from a newer version is shown but never written', () => {
  const { threads, ui } = setup();
  fs.mkdirSync(threads);
  const body = JSON.stringify({ schemaVersion: 3, id: 'cx-9', segments: [{ kind: 'codex', nativeId: 'cx-9' }], meta: { pinned: true } });
  fs.writeFileSync(path.join(threads, 'cx-9.v2'), body);
  const store = new ChatsStore(threads, { uiState: ui });
  assert.deepEqual(store.snapshot().newer, ['cx-9']);
  assert.equal(store.snapshot().chats['cx-9'].meta.pinned, true);
  assert.equal(store.patchMeta('cx-9', { pinned: false }), false);
  assert.equal(fs.readFileSync(path.join(threads, 'cx-9.v2'), 'utf8'), body);
});

test('#39: two windows changing different prefs both keep their change', () => {
  const { ui } = setup();
  // window A turns on one setting, window B another, each from its own (stale) copy
  patchPrefs(ui, { autoUpdate: false });
  patchPrefs(ui, { theme: 'light' });
  patchPrefs(ui, {}, ['model']);
  assert.deepEqual(json(ui).prefs, { theme: 'light', autoUpdate: false });
  // a window's own keys never carry prefs or chat state over main's
  writeRendererState(ui, { sidebarOpen: false, prefs: { theme: 'stale' }, pinned: { x: true } });
  const s = json(ui);
  assert.equal(s.sidebarOpen, false);
  assert.deepEqual(s.prefs, { theme: 'light', autoUpdate: false });
  assert.ok(!('pinned' in s));
  // ui-state from a newer version: prefs read-only
  fs.writeFileSync(ui, JSON.stringify({ stateVersion: 3, prefs: { theme: 'dark' } }));
  assert.equal(patchPrefs(ui, { theme: 'light' }), null);
  assert.equal(json(ui).prefs.theme, 'dark');
});

test('the store maps turn into per-chat patches with only what changed', () => {
  const prev = mapsFromSnapshot({ chats: {}, newer: [] });
  const next = { ...prev, pinned: { a: true }, unread: { b: false }, claudeArchived: { 'claude:c': 9 }, worktreeOf: { d: '/w' } };
  assert.deepEqual(chatChanges(prev, next), {
    meta: { a: { pinned: true }, 'claude:c': { archived: 9 }, d: { worktreeOf: '/w' } },
    segments: {},
  });
  const started = { ...prev, chatProject: { 'claude:n': 'p1' } };
  assert.deepEqual(chatChanges(prev, started).meta, { 'claude:n': { projectId: 'p1' } });
  assert.equal(applyChat(prev, 'claude:n', { segments: null, meta: { projectId: 'p1' } as any }).chatProject['claude:n'], 'p1');
  assert.deepEqual(applyChat(started, 'claude:n', { segments: null, meta: { projectId: null } as any }).chatProject, {});
  const later = { ...next, pinned: {}, claudeChats: { 'claude:c': { id: 'x', pinned: true } } };
  assert.deepEqual(chatChanges(next, later).meta, { a: { pinned: false }, 'claude:c': { account: { id: 'x', pinned: true } } });
  const segs = [{ harness: 'codex', nativeId: 'a', start: 0, count: 1, model: null, handoff: null }] as any;
  assert.deepEqual(chatChanges(prev, { ...prev, segments: { a: segs } }).segments, { a: segs });
  assert.deepEqual(chatChanges({ ...prev, segments: { a: segs } }, prev).segments, { a: null });
});

test("another window's chat change lands in the maps without disturbing the rest", () => {
  const maps = mapsFromSnapshot({
    chats: { a: { segments: null, meta: { pinned: true, unread: false, archived: null, worktreeOf: null, account: null } as any } },
    newer: [],
  });
  assert.deepEqual(maps.pinned, { a: true });
  const next = applyChat(maps, 'b', {
    segments: null,
    meta: { pinned: false, unread: true, archived: 3, worktreeOf: '/w', account: { id: 'k', pinned: false } } as any,
  });
  assert.deepEqual(
    [next.pinned, next.unread, next.claudeArchived, next.worktreeOf, next.claudeChats],
    [{ a: true }, { b: true }, { b: 3 }, { b: '/w' }, { b: { id: 'k', pinned: false } }],
  );
  assert.equal(next.segments, maps.segments, 'untouched maps keep their identity');
  assert.deepEqual(applyChat(next, 'a', null).pinned, {});
});

test('prefs deltas: set what changed, unset what went, and apply on the other side', () => {
  const d = prefsDelta({ a: 1, b: { x: 1 }, c: 3 }, { a: 1, b: { x: 2 }, d: 4 });
  assert.deepEqual(d, { set: { b: { x: 2 }, d: 4 }, unset: ['c'], empty: false });
  assert.equal(prefsDelta({ a: { x: 1 } }, { a: { x: 1 } }).empty, true);
  assert.deepEqual(applyPrefsDelta({ a: 1, c: 3 }, d), { a: 1, b: { x: 2 }, d: 4 });
});

test('navigation bookmarks persist per chat, coexist with pins, and synchronize without changing other metadata', () => {
  const { threads, ui } = setup();
  const a = new ChatsStore(threads, { uiState: ui });
  const id = '["turn","prompt"]';
  a.patchMeta('cx-nav', { pinned: true, navigationBookmarks: [id] });
  a.patchMeta('cx-other', { navigationBookmarks: ['other'] });
  const b = new ChatsStore(threads, { uiState: ui });
  const before = mapsFromSnapshot(b.snapshot());
  assert.deepEqual(before.navigationBookmarks, { 'cx-nav': [id], 'cx-other': ['other'] });
  const next = { ...before, navigationBookmarks: { 'cx-other': before.navigationBookmarks!['cx-other'] } };
  const changes = chatChanges(before, next);
  assert.deepEqual(changes, { meta: { 'cx-nav': { navigationBookmarks: [] } }, segments: {} });
  b.patchMeta('cx-nav', changes.meta['cx-nav']);
  assert.equal(b.get('cx-nav').meta.pinned, true);
  assert.deepEqual(b.get('cx-nav').meta.navigationBookmarks, []);
  assert.deepEqual(applyChat(before, 'cx-nav', b.get('cx-nav')).navigationBookmarks, next.navigationBookmarks);
  assert.deepEqual(applyChat(before, 'cx-nav', null).navigationBookmarks, next.navigationBookmarks);
  assert.deepEqual(new ChatsStore(threads, { uiState: ui }).get('cx-other').meta.navigationBookmarks, ['other']);
});

test('old chat snapshots and old maps without navigation bookmarks remain compatible', () => {
  const before = mapsFromSnapshot(null);
  const { navigationBookmarks: ignored, ...oldMaps } = before;
  const oldChat = { ...new ChatsStore(setup().threads).record('cx-old'), meta: {} } as any;
  assert.deepEqual(applyChat(oldMaps, 'cx-old', oldChat), { ...oldMaps, segments: { 'cx-old': oldChat.segments } });
  assert.deepEqual(chatChanges(oldMaps, { ...oldMaps, navigationBookmarks: { 'cx-old': ['prompt'] } }).meta, {
    'cx-old': { navigationBookmarks: ['prompt'] },
  });
  assert.deepEqual(chatChanges({ ...oldMaps, navigationBookmarks: { 'cx-old': ['prompt'] } }, oldMaps).meta, {
    'cx-old': { navigationBookmarks: [] },
  });
});

test('a commit is on the disk before it returns, as the exact JSON it was: a process that ends right after has written it', () => {
  const { threads } = setup();
  const store = new ChatsStore(threads, { now: () => 9 });
  // two commits of one chat back to back: the later one is the file, and no temporary file stays
  store.patchMeta('cx-1', { pinned: true });
  store.patchMeta('cx-1', { unread: true });
  assert.equal(fs.readFileSync(path.join(threads, 'cx-1.v2'), 'utf8'), JSON.stringify(store.records.get('cx-1')));
  assert.deepEqual(fs.readdirSync(threads), ['cx-1.v2']);
  // a commit during quit: the process exits in the same tick, with nothing left to flush
  const quit = `const { ChatsStore } = require(${JSON.stringify(require.resolve('../electron/platform/chats.cjs'))});
    new ChatsStore(${JSON.stringify(threads)}, { legacyMirror: false }).patchMeta('cx-2', { archived: 5 });
    process.exit(0);`;
  const run = spawnSync(process.execPath, ['-e', quit], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(threads, 'cx-2.v2'), 'utf8')).meta.archived, 5);
});

// root writes into a read-only folder, so nothing would be refused
const asRoot = process.platform === 'win32' || process.getuid?.() === 0;
test('a commit the disk refuses throws, and the chat stays as it was in memory, on the disk and to every listener', {
  skip: asRoot,
}, (t) => {
  const { threads } = setup();
  t.after(() => fs.chmodSync(threads, 0o700));
  const heard: string[] = [];
  const store = new ChatsStore(threads, { now: () => 9, onChange: (id: string) => heard.push(id) });
  store.patchMeta('cx-1', { pinned: true });
  const before = fs.readFileSync(path.join(threads, 'cx-1.v2'), 'utf8');
  const kept = store.records.get('cx-1');
  fs.chmodSync(threads, 0o500);
  assert.throws(
    () => store.patchMeta('cx-1', { unread: true }),
    (error: NodeJS.ErrnoException) =>
      error.code === 'EACCES' && /^EACCES: permission denied, open '.*\.mopilot-\d+-[0-9a-f-]+\.tmp'$/.test(error.message),
  );
  assert.equal(store.records.get('cx-1'), kept);
  assert.equal(store.get('cx-1').meta.unread, false);
  assert.deepEqual(heard, ['cx-1']);
  fs.chmodSync(threads, 0o700);
  assert.equal(fs.readFileSync(path.join(threads, 'cx-1.v2'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(threads), ['cx-1.v2']);
});
