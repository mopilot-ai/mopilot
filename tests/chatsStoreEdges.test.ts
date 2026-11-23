// electron/platform/chats.cjs edge cases: bad input, damaged files, mirror failures, the items log and
// the chats:* / prefs:patch IPC, in a temp userData.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const chats = require('../electron/platform/chats.cjs');
const { ChatsStore, ItemsLog, registerChats, patchPrefs, writeRendererState, readUiState, toRendererSegment } = chats;

import { tmp } from './support/chat-store-profile.ts';
const segs = [
  { harness: 'codex', nativeId: 'a' },
  { harness: 'claude', nativeId: 'claude:b' },
];

test('toRendererSegment fills defaults for missing fields', () => {
  assert.deepEqual(toRendererSegment({ kind: 'claude', nativeId: 'x' }), {
    harness: 'claude',
    nativeId: 'claude:x',
    start: 0,
    count: null,
    model: null,
    handoff: null,
  });
});

test('ui-state that is not an object reads as {}; prefs that are not an object start over', (t) => {
  const { ui } = tmp(t);
  fs.writeFileSync(ui, '[1,2]');
  assert.deepEqual(readUiState(ui), {});
  fs.writeFileSync(ui, JSON.stringify({ prefs: 'bad', keep: 1 }));
  assert.deepEqual(patchPrefs(ui, { a: 1 }), { a: 1 });
  assert.deepEqual(patchPrefs(ui), { a: 1 });
  assert.equal(JSON.parse(fs.readFileSync(ui, 'utf8')).keep, 1);
});

test('an unreadable ui-state is kept aside before a change writes over it', (t) => {
  const { ui } = tmp(t);
  const torn = '{"prefs":{"model":"m","hiddenFolders":["/w"]},"sidebar":{"coll';
  fs.writeFileSync(ui, torn);
  assert.deepEqual(patchPrefs(ui, { notifyOnComplete: true }), { notifyOnComplete: true });
  // what it held is still there to recover
  assert.equal(fs.readFileSync(`${ui}.unreadable`, 'utf8'), torn);
  // a copy already kept is the oldest one, and stays
  fs.writeFileSync(ui, '{"again');
  patchPrefs(ui, { a: 1 });
  assert.equal(fs.readFileSync(`${ui}.unreadable`, 'utf8'), torn);
});

test('writeRendererState ignores non-objects', (t) => {
  const { ui } = tmp(t);
  writeRendererState(ui, null);
  writeRendererState(ui, 'x');
  assert.equal(fs.existsSync(ui), false);
});

test('load skips damaged records and fills missing meta; get of an unknown chat is null', (t) => {
  const { threads } = tmp(t);
  fs.writeFileSync(path.join(threads, 'a.v2'), JSON.stringify({ id: 5, segments: [] }));
  fs.writeFileSync(path.join(threads, 'b.v2'), JSON.stringify({ id: 'b', schemaVersion: 2, segments: 'no' }));
  fs.writeFileSync(path.join(threads, 'c.v2'), 'not json');
  fs.writeFileSync(path.join(threads, 'd.v2'), JSON.stringify({ id: 'd', schemaVersion: 2, segments: [{ kind: 'codex', nativeId: 'd' }] }));
  fs.writeFileSync(path.join(threads, 'notes.txt'), '');
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.deepEqual(Object.keys(store.snapshot().chats), ['d']);
  assert.equal(store.get('d').meta.pinned, false);
  assert.equal(store.get('zzz'), null);
  // a chat whose file can't be read is never written over: opening it (ensure) or a pin would drop its later
  // segments and its settings
  for (const [id, file] of [
    ['c', 'c.v2'],
    ['b', 'b.v2'],
  ]) {
    const before = fs.readFileSync(path.join(threads, file), 'utf8');
    assert.equal(store.ensure(id), false, id);
    assert.equal(store.patchMeta(id, { pinned: true }), false, id);
    assert.equal(fs.readFileSync(path.join(threads, file), 'utf8'), before, id);
  }
  // a name that doesn't decode to an id is skipped too
  fs.writeFileSync(path.join(threads, '%E0%A4%A.v2'), 'not json');
  fs.writeFileSync(path.join(threads, '.v2'), 'not json');
  assert.deepEqual(Object.keys(new ChatsStore(threads, { legacyMirror: false }).snapshot().chats), ['d']);
});

test('one malformed transcript filename cannot hide valid chat history', async (t) => {
  const { threads, own } = tmp(t);
  const log = own(new ItemsLog(threads));
  log.append('acp:test:hello/%', { text: 'keep' });
  fs.writeFileSync(path.join(threads, '%ZZ.items.jsonl'), 'bad');
  fs.writeFileSync(path.join(threads, '%E0%A4%A.items.jsonl'), 'bad');
  assert.deepEqual(
    log.list().map((r: any) => r.id),
    ['acp:test:hello/%'],
  );
  assert.deepEqual(await log.readAsync('acp:test:hello/%'), [{ text: 'keep' }]);
});

test('a chat record cannot replace or freeze a sibling whose id it claims', (t) => {
  const { threads } = tmp(t);
  const owner = path.join(threads, 'a.v2');
  const misplaced = path.join(threads, 'z.v2');
  fs.writeFileSync(owner, JSON.stringify({ id: 'a', schemaVersion: 2, segments: [{ kind: 'codex', nativeId: 'real' }] }));
  const foreign = JSON.stringify({ id: 'a', schemaVersion: 999, segments: [{ kind: 'claude', nativeId: 'wrong' }] });
  fs.writeFileSync(misplaced, foreign);
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.equal(store.get('a').kind, 'codex');
  assert.deepEqual(store.snapshot().newer, []);
  assert.equal(store.patchMeta('a', { pinned: true }), true);
  assert.equal(JSON.parse(fs.readFileSync(owner, 'utf8')).meta.pinned, true);
  assert.equal(fs.readFileSync(misplaced, 'utf8'), foreign, 'the misplaced record remains available for recovery');
});

test('an unencodable stored chat id is skipped without breaking the whole store', (t) => {
  const { threads } = tmp(t);
  fs.writeFileSync(path.join(threads, 'bad.v2'), JSON.stringify({ id: '\ud800', segments: [{ kind: 'codex', nativeId: 'bad' }] }));
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.deepEqual(store.snapshot().chats, {});
});

test('patchMeta and setSegments refuse bad input; undefined clears; no-ops return false', (t) => {
  const { threads } = tmp(t);
  const store = new ChatsStore(threads, { legacyMirror: () => false });
  assert.equal(store.patchMeta('', { pinned: true }), false);
  assert.equal(store.patchMeta(5, { pinned: true }), false);
  assert.equal(store.patchMeta('x', null), false);
  assert.equal(store.patchMeta('x', 'str'), false);
  assert.equal(store.patchMeta('x', { worktreeOf: '/w' }), true);
  assert.equal(store.patchMeta('x', { worktreeOf: undefined }), true);
  assert.equal(store.get('x').meta.worktreeOf, null);
  assert.equal(store.setSegments('', segs), false);
  assert.equal(store.setSegments(1, segs), false);
  assert.equal(store.setSegments('new', null), false, 'a single own segment for a chat without a record is not written');
  assert.equal(store.setSegments('y', segs), true);
  assert.equal(store.setSegments('y', segs), false, 'unchanged');
});

test('mirror failures (legacy file blocked, ui-state unwritable) are ignored', (t) => {
  const { d, threads } = tmp(t);
  fs.writeFileSync(path.join(d, 'blocker'), '');
  // a directory where the legacy segment file would be removed
  fs.mkdirSync(path.join(threads, 'z.json'));
  const store = new ChatsStore(threads, { uiState: path.join(d, 'blocker', 'ui-state.json') });
  assert.equal(store.patchMeta('z', { pinned: true }), true);
  assert.equal(store.get('z').meta.pinned, true);
});

test('legacy keys are written in id order', (t) => {
  const { threads, ui } = tmp(t);
  const store = new ChatsStore(threads, { uiState: ui });
  for (const id of ['m', 'b', 'x', 'a']) store.patchMeta(id, { pinned: true });
  assert.deepEqual(Object.keys((chats.flushPendingWrites(), JSON.parse(fs.readFileSync(ui, 'utf8'))).pinned), ['a', 'b', 'm', 'x']);
});

test('ItemsLog: bad appends are ignored; has, list (missing dir, vanished file) and remove', (t) => {
  const { d, own } = tmp(t);
  const log = own(new ItemsLog(path.join(d, 'items')));
  assert.deepEqual(log.list(), []);
  log.append('', { a: 1 });
  log.append('c1');
  assert.equal(log.has('c1'), false);
  log.append('c1', { a: 1 });
  assert.equal(log.has('c1'), true);
  t.mock.method(fs, 'statSync', () => undefined);
  assert.deepEqual(log.list(), [{ id: 'c1', mtime: 0 }]);
  t.mock.restoreAll();
  log.remove('c1');
  assert.equal(log.has('c1'), false);
  log.remove('c1');
});

test('IPC: snapshot, patches broadcast to every window only when they change; prefs:patch to the others', (t) => {
  const { threads, ui } = tmp(t);
  const store = new ChatsStore(threads, { uiState: ui });
  const h = new Map<string, any>();
  const sent: any[] = [];
  const prefsSeen: any[] = [];
  registerChats(
    { handle: (ch: string, f: any) => h.set(ch, f) },
    { store, uiState: ui, broadcast: (...a: any[]) => sent.push(a), onPrefs: (p: any) => prefsSeen.push(p) },
  );
  const e = { sender: 'w1' };
  assert.equal(h.get('chats:patchMeta')(e, 'c', { unread: true }), true);
  assert.equal(h.get('chats:patchMeta')(e, 'c', { unread: true }), false);
  assert.equal(h.get('chats:setSegments')(e, 'c', segs), true);
  assert.equal(h.get('chats:setSegments')(e, 'c', segs), false);
  assert.deepEqual(
    sent.map((s) => [s[0], s[1], s[2].id]),
    [
      ['chats:changed', null, 'c'],
      ['chats:changed', null, 'c'],
    ],
  );
  assert.deepEqual(Object.keys(h.get('chats:snapshot')().chats), ['c']);
  assert.equal(h.get('prefs:patch')(e, { theme: 'dark' }, ['old']), true);
  assert.deepEqual(sent.at(-1), ['prefs:changed', 'w1', { set: { theme: 'dark' }, unset: ['old'] }]);
  assert.equal(h.get('prefs:patch')(e, null, 'x'), true);
  assert.deepEqual(sent.at(-1), ['prefs:changed', 'w1', { set: {}, unset: [] }]);
  assert.equal(h.get('prefs:patch')(e, undefined, undefined), true);
  assert.deepEqual(sent.at(-1)[2], { set: {}, unset: [] });
  assert.equal(prefsSeen.length, 3);
  // a newer build's ui-state: refused, nothing broadcast
  chats.flushPendingWrites(), fs.writeFileSync(ui, JSON.stringify({ stateVersion: 1e9 }));
  const before = sent.length;
  assert.equal(h.get('prefs:patch')(e, { a: 1 }, []), false);
  assert.equal(sent.length, before);
});

test('registerChats without onPrefs', (t) => {
  const { threads, ui } = tmp(t);
  const h = new Map<string, any>();
  registerChats({ handle: (ch: string, f: any) => h.set(ch, f) }, { store: new ChatsStore(threads), uiState: ui, broadcast: () => {} });
  assert.equal(h.get('prefs:patch')({}, { a: 1 }, []), true);
});

test('ensure gives a chat nothing has touched its own record, once, for every harness family', (t) => {
  const { threads } = tmp(t);
  const changed: string[] = [];
  const store = new ChatsStore(threads, { legacyMirror: false, onChange: (id: string) => changed.push(id) });
  for (const id of ['acp:kimi:1', 'claude:2', '3']) assert.equal(store.ensure(id), true);
  assert.deepEqual(changed, ['acp:kimi:1', 'claude:2', '3']);
  assert.equal(store.get('acp:kimi:1').kind, 'acp:kimi');
  assert.ok(fs.existsSync(store.file('acp:kimi:1')));
  // a chat that has a record is left alone
  assert.equal(store.ensure('acp:kimi:1'), true);
  assert.equal(changed.length, 3);
  // not a chat id
  for (const bad of ['', 5, null, 'x'.repeat(257)]) assert.equal(store.ensure(bad), false);
  assert.equal(changed.length, 3);
  // a chat written by a newer build is not overwritten
  store.newer.add('newer');
  assert.equal(store.ensure('newer'), false);
});

test('empty chat segments cannot break snapshots, and future empty records stay write-protected', (t) => {
  const { threads } = tmp(t);
  const ids = ['codex-empty', 'claude:empty', 'acp:test:empty'];
  for (const id of ids)
    fs.writeFileSync(path.join(threads, encodeURIComponent(id) + '.v2'), JSON.stringify({ id, schemaVersion: 2, segments: [] }));
  const future = path.join(threads, 'future.v2');
  const contents = JSON.stringify({ id: 'future', schemaVersion: 999, segments: [] });
  fs.writeFileSync(future, contents);
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.deepEqual(store.snapshot().chats, {});
  assert.deepEqual(store.snapshot().newer, ['future']);
  for (const id of ids) assert.equal(store.get(id), null);
  assert.equal(store.ensure('future'), false);
  assert.equal(fs.readFileSync(future, 'utf8'), contents);
});

test('malformed segment entries never publish, including later entries and future record shapes', (t) => {
  const { threads } = tmp(t);
  const bad = [
    'not an array',
    [null],
    [5],
    ['text'],
    [{}],
    [{ kind: 5, nativeId: 'id' }],
    [{ kind: 'codex', nativeId: 5 }],
    [{ kind: 'codex', nativeId: 'valid' }, null],
  ];
  const future: string[] = [];
  for (let i = 0; i < bad.length; i++)
    for (const version of [1, 999]) {
      const id = `bad-${i}-${version}`;
      if (version === 999) future.push(id);
      fs.writeFileSync(path.join(threads, `${id}.v2`), JSON.stringify({ id, schemaVersion: version, segments: bad[i] }));
    }
  const store = new ChatsStore(threads, { legacyMirror: false });
  assert.deepEqual(store.snapshot().chats, {});
  assert.deepEqual(store.snapshot().newer.sort(), future.sort());
  for (const id of future) {
    const file = path.join(threads, `${id}.v2`);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(store.ensure(id), false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('legacy fallback isolates damaged segment records and never overwrites them', (t) => {
  const { d, threads, ui } = tmp(t);
  const invalid = [null, {}, { nativeId: 7 }, { nativeId: '' }, { harness: 'claude', nativeId: 'claude:' }];
  const saved = new Map<string, string>();
  for (const [i, segment] of invalid.entries()) {
    const id = `bad-${i}`;
    const file = path.join(threads, `${id}.json`);
    const text = JSON.stringify({ id, segments: [segment] });
    fs.writeFileSync(file, text);
    saved.set(file, text);
  }
  fs.writeFileSync(path.join(threads, 'good.json'), JSON.stringify({ id: 'good', segments: segs }));
  const legacy = {
    pinned: { 'bad-0': true },
    unread: { 'bad-0': true },
    worktreeOf: { 'bad-0': '/repo' },
    claudeArchived: { 'bad-0': 42 },
    claudeChats: { 'bad-0': { id: 'account', pinned: true } },
  };
  fs.writeFileSync(ui, JSON.stringify(legacy));
  const store = new ChatsStore(threads, { uiState: ui, fallback: true });
  assert.deepEqual(Object.keys(store.snapshot().chats), ['good']);
  assert.equal(store.get('good').segments.length, 2);
  for (const [i] of invalid.entries()) {
    assert.equal(store.ensure(`bad-${i}`), false);
    assert.equal(store.patchMeta(`bad-${i}`, { pinned: true }), false);
    assert.equal(store.setSegments(`bad-${i}`, segs), false);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(ui, 'utf8')), legacy);
  assert.equal(store.patchMeta('good', { pinned: true }), true);
  const mirrored = JSON.parse(fs.readFileSync(ui, 'utf8'));
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(mirrored[key]['bad-0'], value['bad-0']);
  assert.equal(mirrored.pinned.good, true);
  for (const [file, text] of saved) assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(fs.existsSync(path.join(d, 'threads', 'bad-0.v2')), false);
  fs.writeFileSync(path.join(threads, 'bad-0.json'), JSON.stringify({ id: 'bad-0', segments: segs }));
  store.load();
  assert.equal(store.get('bad-0').meta.unread, true);
  assert.equal(store.get('bad-0').meta.worktreeOf, '/repo');
  assert.equal(store.ensure('bad-0'), true);
  assert.equal(store.patchMeta('bad-0', { pinned: false }), true);
  assert.equal(JSON.parse(fs.readFileSync(ui, 'utf8')).pinned['bad-0'], undefined);
  // Absent legacy maps have no unreadable metadata to preserve.
  fs.writeFileSync(ui, '{}');
  assert.equal(store.patchMeta('good', { unread: true }), true);
  assert.equal(JSON.parse(fs.readFileSync(ui, 'utf8')).unread.good, true);
});

test('legacy fallback preserves files with invalid owners and their UI metadata', (t) => {
  const { threads, ui } = tmp(t);
  const owners = ['foreign', 'bad-unicode', 'bad-type'];
  const bodies = ['other', '\ud800', 5];
  const saved = owners.map((id, i) => {
    const file = path.join(threads, `${id}.json`);
    const text = JSON.stringify({ id: bodies[i], segments: segs });
    fs.writeFileSync(file, text);
    return [file, text];
  });
  for (const name of ['ali%61s.json', 'bad%ZZ.json']) {
    const file = path.join(threads, name);
    const text = JSON.stringify({ id: 'alias', segments: segs });
    fs.writeFileSync(file, text);
    saved.push([file, text]);
  }
  fs.writeFileSync(path.join(threads, 'good.json'), JSON.stringify({ id: 'good', segments: segs }));
  fs.writeFileSync(ui, JSON.stringify({ pinned: Object.fromEntries(owners.map((id) => [id, true])) }));
  const v2 = require('../electron/migrations/2026-10-threads-v2.cjs');
  assert.deepEqual(v2.run({ userData: path.dirname(threads) }).failed.sort(), [...owners].sort());
  const store = new ChatsStore(threads, { uiState: ui, fallback: true });
  assert.deepEqual(Object.keys(store.snapshot().chats), ['good']);
  for (const id of owners) {
    assert.equal(store.ensure(id), false);
    assert.equal(store.patchMeta(id, { unread: true }), false);
  }
  assert.equal(store.patchMeta('good', { unread: true }), true);
  for (const id of owners) assert.equal(JSON.parse(fs.readFileSync(ui, 'utf8')).pinned[id], true);
  for (const [file, text] of saved) assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('legacy fallback cannot overwrite a segment file that could not be read', (t) => {
  const { threads, ui } = tmp(t);
  const file = path.join(threads, 'blocked.json');
  const original = JSON.stringify({ id: 'blocked', segments: segs });
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(threads, 'good.json'), JSON.stringify({ id: 'good', segments: segs }));
  fs.writeFileSync(ui, JSON.stringify({ pinned: { blocked: true } }));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target: any, ...args: any[]) => {
    if (target === file) throw Object.assign(new Error('cannot read'), { code: 'EACCES' });
    return read.apply(fs, [target, ...args] as any);
  });
  const store = new ChatsStore(threads, { uiState: ui, fallback: true });
  assert.deepEqual(Object.keys(store.snapshot().chats), ['good']);
  assert.equal(store.ensure('blocked'), false);
  assert.equal(store.patchMeta('good', { unread: true }), true);
  assert.equal(JSON.parse(fs.readFileSync(ui, 'utf8')).pinned.blocked, true);
  assert.equal(read(file, 'utf8'), original);
});

test('invalid legacy owners without UI metadata keep migration in protected fallback', (t) => {
  const { d, threads, ui } = tmp(t);
  const file = path.join(threads, 'foreign.json');
  const original = JSON.stringify({ id: 'other', segments: segs });
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(threads, 'good.json'), JSON.stringify({ id: 'good', segments: segs }));
  const v2 = require('../electron/migrations/2026-10-threads-v2.cjs');
  const result = v2.run({ userData: d });
  const store = new ChatsStore(threads, { uiState: ui, fallback: !result.ok });
  assert.equal(store.ensure('foreign'), false);
  assert.equal(store.setSegments('foreign', segs), false);
  assert.equal(store.patchMeta('good', { unread: true }), true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['foreign']);
  assert.equal(result.written, 1);
});

test('transcript filename aliases cannot duplicate a chat or lend it another file time', async (t) => {
  const { threads, own, stopWith } = tmp(t);
  const log = own(new ItemsLog(threads));
  const id = 'acp:fake:a';
  log.append(
    id,
    { t: 'session', sessionId: 'native', cwd: '/repo', at: 1 },
    { t: 'user', user: { content: [{ type: 'text', text: 'hello' }] } },
  );
  fs.utimesSync(log.file(id), 10, 10);
  const aliases = ['acp%3Afake%3A%61.items.jsonl', 'acp%3A%66ake%3Aa.items.jsonl', '.items.jsonl'];
  for (const name of aliases) {
    fs.writeFileSync(path.join(threads, name), 'preserve');
    fs.utimesSync(path.join(threads, name), 20, 20);
  }
  const { AcpHost } = require('../electron/harness/acp.cjs');
  const host = new AcpHost({ items: log, quirks: () => null, resolveBin: () => null });
  stopWith(() => host.closeAll());
  assert.deepEqual(
    (await host.list()).map((c: any) => [c.id, c.updatedAt]),
    [[id, 10000]],
  );
  assert.deepEqual(
    (await host.search('hello')).map((c: any) => c.id),
    [id],
  );
  assert.deepEqual(log.list(), [{ id, mtime: 10000 }]);
  for (const name of aliases) assert.equal(fs.readFileSync(path.join(threads, name), 'utf8'), 'preserve');
});

for (const value of [true, 42, 'damaged', [1, 2], null]) {
  test(`UI writes keep a recovery copy of a non-record root ${JSON.stringify(value)}`, (t) => {
    const { ui } = tmp(t);
    const original = JSON.stringify(value);
    fs.writeFileSync(ui, original);
    assert.deepEqual(patchPrefs(ui, { theme: 'light' }), { theme: 'light' });
    assert.equal(fs.readFileSync(`${ui}.unreadable`, 'utf8'), original);
    assert.deepEqual((chats.flushPendingWrites(), JSON.parse(fs.readFileSync(ui, 'utf8'))), { prefs: { theme: 'light' } });
    fs.writeFileSync(ui, '["later"]');
    patchPrefs(ui, { theme: 'dark' });
    assert.equal(fs.readFileSync(`${ui}.unreadable`, 'utf8'), original);
  });
}

test('UI record boundaries reject array preferences and renderer state', (t) => {
  const { ui } = tmp(t);
  fs.writeFileSync(ui, JSON.stringify({ prefs: ['old'], sidebar: 'keep' }));
  assert.deepEqual(patchPrefs(ui, { theme: 'light' }), { theme: 'light' });
  assert.deepEqual(patchPrefs(ui, ['new']), { theme: 'light' });
  const before = fs.readFileSync(ui, 'utf8');
  writeRendererState(ui, ['sidebar']);
  assert.equal(fs.readFileSync(ui, 'utf8'), before);
});

test('prefs IPC publishes the same admitted delta that it persists', (t) => {
  const { threads, ui } = tmp(t);
  const h = new Map<string, any>();
  const sent: any[] = [];
  const seen: any[] = [];
  registerChats(
    { handle: (channel: string, fn: any) => h.set(channel, fn) },
    {
      store: new ChatsStore(threads),
      uiState: ui,
      broadcast: (...args: any[]) => sent.push(args),
      onPrefs: (prefs: any) => seen.push(prefs),
    },
  );
  patchPrefs(ui, { theme: 'light', retained: true });
  for (const [set, unset] of [
    [['bad'], 'retained'],
    [false, { retained: true }],
    [null, null],
  ]) {
    assert.equal(h.get('prefs:patch')({ sender: 'w' }, set, unset), true);
    assert.deepEqual(sent.at(-1), ['prefs:changed', 'w', { set: {}, unset: [] }]);
    assert.deepEqual(seen.at(-1), { theme: 'light', retained: true });
    assert.deepEqual((chats.flushPendingWrites(), JSON.parse(fs.readFileSync(ui, 'utf8'))).prefs, seen.at(-1));
  }
});

test('a folder that could not be listed keeps its chats: a record for one it could not see is not written over it', {
  skip: process.platform === 'win32',
}, (t) => {
  const { threads } = tmp(t);
  const saved = JSON.stringify({ id: 'kept', schemaVersion: 2, meta: { title: 'Mine' } });
  fs.writeFileSync(path.join(threads, 'kept.v2'), saved);
  fs.chmodSync(threads, 0o300); // files reachable by name, the folder not listable
  let store;
  try {
    store = new ChatsStore(threads, { legacyMirror: false });
    assert.equal(store.unlisted, true);
    assert.equal(store.ensure('kept'), false);
    assert.equal(store.ensure('new'), true);
  } finally {
    fs.chmodSync(threads, 0o700);
  }
  assert.equal(fs.readFileSync(path.join(threads, 'kept.v2'), 'utf8'), saved);
  store.load();
  assert.equal(store.unlisted, false);
});
