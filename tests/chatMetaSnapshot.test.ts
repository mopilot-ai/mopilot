// Snapshot map construction stays linear, sparse and equivalent to immutable incremental chat updates.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChat, mapsFromSnapshot } from '../src/lib/chatMeta.ts';
import type { ChatMaps, ChatMeta, ChatView, ChatsSnapshot } from '../src/lib/chatMeta.ts';

const view = (meta: Partial<ChatMeta> = {}, segments: ChatView['segments'] = null): ChatView => ({
  segments,
  meta: {
    pinned: false,
    unread: false,
    worktreeOf: null,
    projectId: null,
    archived: null,
    account: null,
    config: null,
    goalHeld: null,
    notes: [],
    computerGrants: [],
    ...meta,
  },
});

const empty = (): ChatMaps => ({
  chatInitialTitles: {},
  chatRewoundAt: {},
  pinned: {},
  unread: {},
  worktreeOf: {},
  chatProject: {},
  claudeArchived: {},
  claudeChats: {},
  chatNotes: {},
  chatConfig: {},
  navigationBookmarks: {},
  chatForkOf: {},
  momoChats: {},
  momoModels: {},
  authoredInputs: {},
  segments: {},
});

function incremental(snapshot: ChatsSnapshot) {
  return Object.entries(snapshot.chats).reduce((maps, [id, chat]) => applyChat(maps, id, chat), empty());
}

test('snapshot construction matches sparse incremental maps for every field and harness', () => {
  const segments: ChatView['segments'] = [{ harness: 'codex', nativeId: 'native', start: 0, count: null, model: null, handoff: null }];
  const chats = {
    'cx-1': view(
      {
        pinned: true,
        unread: true,
        worktreeOf: '/work',
        projectId: 'project',
        archived: 0,
        account: { id: 'login', pinned: true },
        config: { model: 'm' },
        notes: [{ id: 'note' }],
        navigationBookmarks: ['turn'],
        forkOf: 'source',
        momo: 'main',
        momoModel: 'claude-opus-4-7',
        authored: { in1: { by: 'momo', title: 'Today’s edition', at: 1 } },
        initialTitle: '  Login timing  ',
        rewoundAt: 8,
      },
      segments,
    ),
    'claude:2': view({ archived: 7, config: {}, account: { id: 'other', pinned: false } }),
    'acp:goose:3': view(),
    optional: { segments: null, meta: {} as ChatMeta },
    badOptional: view({
      notes: 'invalid' as unknown as unknown[],
      config: 'invalid',
      navigationBookmarks: 'invalid' as unknown as string[],
      archived: 'invalid' as unknown as number,
      initialTitle: 42 as unknown as string,
      rewoundAt: 'invalid' as unknown as number,
    }),
  };
  const snapshot = { chats, newer: ['claude:2'] };
  const before = structuredClone(snapshot);
  const maps = mapsFromSnapshot(snapshot);
  assert.deepEqual(maps, incremental(snapshot));
  assert.deepEqual(maps.pinned, { 'cx-1': true });
  assert.deepEqual(maps.claudeArchived, { 'cx-1': 0, 'claude:2': 7 });
  assert.deepEqual(maps.navigationBookmarks, { 'cx-1': ['turn'] });
  // the chat a fork was made from (#1941)
  assert.deepEqual(maps.chatForkOf, { 'cx-1': 'source' });
  assert.deepEqual(maps.chatInitialTitles, { 'cx-1': 'Login timing' });
  assert.deepEqual(maps.chatRewoundAt, { 'cx-1': 8 });
  for (const rewoundAt of [0, -1, NaN, Infinity, null]) assert.deepEqual(applyChat(maps, 'cx-1', view({ rewoundAt })).chatRewoundAt, {});
  // the Claude Code model a MoMo chat's brain names (#2304)
  assert.deepEqual(maps.momoModels, { 'cx-1': 'claude-opus-4-7' });
  // how an input no human wrote shows (#2287)
  assert.deepEqual(maps.authoredInputs, { 'cx-1': { in1: { by: 'momo', title: 'Today’s edition', at: 1 } } });
  assert.equal(maps.segments['cx-1'], segments);
  assert.deepEqual(snapshot, before);
});

test('null, undefined and empty snapshots allocate independent empty maps', () => {
  const values = [mapsFromSnapshot(null), mapsFromSnapshot(undefined), mapsFromSnapshot({ chats: {}, newer: [] })];
  for (const maps of values) assert.deepEqual(maps, empty());
  values[0].pinned.local = true;
  assert.deepEqual(values[1], empty());
  assert.deepEqual(values[2], empty());
  for (const key of Object.keys(values[1]) as (keyof ChatMaps)[]) assert.notEqual(values[1][key], values[2][key]);
});

test('opaque and prototype-like chat ids remain enumerable own properties', () => {
  const ids = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'a:b', 'a', 'b:c', 'a:b:c', 'quote"\\\n', '0', '9007199254740993'];
  const snapshot = {
    chats: Object.fromEntries(
      ids.map((id) => [id, view({ pinned: true, config: { model: id }, navigationBookmarks: [id], initialTitle: id })]),
    ),
    newer: [],
  };
  const maps = mapsFromSnapshot(snapshot);
  assert.deepEqual(maps, incremental(snapshot));
  for (const key of ['pinned', 'chatConfig', 'navigationBookmarks', 'chatInitialTitles'] as const) {
    assert.equal(Object.getPrototypeOf(maps[key]), Object.prototype);
    assert.deepEqual(Object.keys(maps[key]!).sort(), ids.toSorted());
    for (const id of ids) {
      assert.equal(Object.hasOwn(maps[key]!, id), true);
      assert.deepEqual(Object.getOwnPropertyDescriptor(maps[key]!, id), {
        value: maps[key]![id],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
});

test('separate snapshots and incremental replace/remove keep prior map containers untouched', () => {
  const snapshot = { chats: { same: view({ pinned: true, config: { model: 'first' }, navigationBookmarks: ['first'] }) }, newer: [] };
  const first = mapsFromSnapshot(snapshot);
  const second = mapsFromSnapshot({ chats: { same: view({ unread: true, config: { model: 'second' } }) }, newer: [] });
  const updated = applyChat(first, 'same', view({ unread: true, config: { model: 'second' } }));
  assert.deepEqual(updated, second);
  assert.deepEqual(first, incremental(snapshot));
  assert.deepEqual(applyChat(updated, 'same', null), empty());
  assert.deepEqual(second, updated);
  const unchanged = applyChat(first, 'same', structuredClone(snapshot.chats.same));
  for (const key of Object.keys(first) as (keyof ChatMaps)[]) assert.equal(unchanged[key], first[key]);
});

test('snapshot conversion reads each chat once and keeps shared value references', () => {
  const chat = view({ pinned: true, config: { model: 'shared' }, notes: [{ id: 'note' }] });
  let reads = 0;
  const chats: Record<string, ChatView> = {};
  for (let i = 0; i < 2000; i++)
    Object.defineProperty(chats, `chat-${i}`, {
      enumerable: true,
      get: () => {
        reads++;
        return chat;
      },
    });
  const maps = mapsFromSnapshot({ chats, newer: [] });
  assert.equal(reads, 2000);
  assert.equal(Object.keys(maps.pinned).length, 2000);
  assert.equal(Object.keys(maps.chatNotes).length, 2000);
  assert.equal(maps.chatConfig['chat-1999'], chat.meta.config);
  assert.equal(maps.chatNotes['chat-1999'], chat.meta.notes);
});

test('an opaque id never borrows inherited state when adding empty config or deleting a chat', () => {
  const maps = empty();
  const chat = view({ config: {} });
  const updated = applyChat(maps, '__proto__', chat);
  assert.equal(Object.hasOwn(updated.chatConfig, '__proto__'), true);
  assert.deepEqual(updated.chatConfig['__proto__'], {});
  assert.deepEqual(mapsFromSnapshot({ chats: { ['__proto__']: chat }, newer: [] }), updated);
  const cleared = applyChat(maps, 'constructor', null);
  for (const key of Object.keys(maps) as (keyof ChatMaps)[]) assert.equal(cleared[key], maps[key]);
});

test('initial titles replace and clear without changing earlier snapshots or accepting blank and malformed values', () => {
  const first = mapsFromSnapshot({ chats: { c: view({ initialTitle: 'First task' }) }, newer: [] });
  const replaced = applyChat(first, 'c', view({ initialTitle: 'Replacement task' }));
  assert.deepEqual(first.chatInitialTitles, { c: 'First task' });
  assert.deepEqual(replaced.chatInitialTitles, { c: 'Replacement task' });
  assert.equal(applyChat(replaced, 'c', view({ initialTitle: 'Replacement task' })).chatInitialTitles, replaced.chatInitialTitles);
  for (const value of ['', '   ', null, undefined, 7]) {
    assert.deepEqual(applyChat(replaced, 'c', view({ initialTitle: value as any })).chatInitialTitles, {});
    assert.deepEqual(first.chatInitialTitles, { c: 'First task' });
  }
  assert.deepEqual(applyChat(replaced, 'c', null).chatInitialTitles, {});
});
