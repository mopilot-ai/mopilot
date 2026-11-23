// Codex read-state notifications follow the current native segment into durable MoPilot unread metadata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setup, selectSegment, codex } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { readStateUnread } = require('../electron/harness/codexReadState.cjs');
const { CodexAdapter, AppServer } = require('../electron/harness/codex.cjs');

const changed = (threadId: unknown, firstUnread: unknown, revision: unknown = 'opaque:9007199254740993') =>
  codex('thread/readState/changed', { threadId, readState: { firstUnread, revision } });

test('server read state persists on the stable current Codex chat, preserving unrelated metadata', () => {
  const { c, chats } = setup();
  selectSegment(c, chats, 'claude:stable', [
    ['claude', 'stable'],
    ['codex', 'native'],
  ]);
  chats.patchMeta('claude:stable', { unread: true, pinned: true });
  c.onCodexMessage(changed('native', null));
  assert.equal(chats.get('claude:stable').meta.unread, false);
  assert.equal(chats.get('claude:stable').meta.pinned, true);
  assert.equal(chats.records.has('native'), false);
  assert.equal(JSON.parse(fs.readFileSync(chats.file('claude:stable'), 'utf8')).meta.unread, false);
});

test('actual adapter maps the notification to a stable chat and its observer persists it without a window', () => {
  const { c, chats, state } = setup();
  const chat = 'opaque:"chat\\:owner';
  const native = 'native:"thread\\:owner';
  selectSegment(c, chats, chat, [
    ['claude', 'first'],
    ['codex', native],
  ]);
  const events: any[] = [];
  const a = new CodexAdapter({
    server: { listeners: new Set() },
    state,
    nativeOf: (id: string) => c.ref(id),
    chatOf: (id: string) => c.chatOf(id),
    observe: (message: any) => c.onCodexMessage(message),
    emit: (event: any) => events.push(event),
  });
  c.codex = a;
  a.onMessage(changed(native, { type: 'turn', turnId: 'turn:"\\:9007199254740993' }));
  assert.equal(chats.get(chat).meta.unread, true);
  assert.equal(state.has(chat), false, 'no window or session registration is required');
  assert.deepEqual(events[0], {
    kind: 'notification',
    chatId: chat,
    method: 'thread/readState/changed',
    params: {
      threadId: chat,
      readState: { firstUnread: { type: 'turn', turnId: 'turn:"\\:9007199254740993' }, revision: 'opaque:9007199254740993' },
    },
  });
  a.onMessage(codex('turn/started', { threadId: native, turn: { id: 'unopened-turn' } }));
  assert.equal(state.has(chat), false);
  a.onMessage(codex('turn/started', { threadId: native, turn: { id: 'replacement-turn' } }));
  a.onMessage(codex('turn/completed', { threadId: native, turn: { id: 'unopened-turn', status: 'interrupted' } }));
  assert.equal(a.running.has(native), true, 'a late stopped-turn completion cannot retire the replacement');
  assert.equal(a.turnOf.get(native), 'replacement-turn');
  a.onMessage(changed(native, null));
  assert.equal(chats.get(chat).meta.unread, true, 'the adapter tracks a turn even if no window opened this chat');
  a.onMessage(codex('turn/completed', { threadId: native, turn: { id: 'replacement-turn', status: 'completed' } }));
  assert.equal(chats.get(chat).meta.unread, true, 'turn completion does not replay the earlier clear');
  a.onMessage(changed(native, null, 'fresh-read'));
  assert.equal(chats.get(chat).meta.unread, false);
});

test('valid thread-start and turn positions mark unread; opaque revisions are never sorted or coerced', () => {
  const { c, chats } = setup();
  chats.ensure('chat');
  for (const revision of ['9007199254740993', '9007199254740992', 'initial:chat', '', 'a"\\b']) {
    c.onCodexMessage(changed('chat', { type: 'threadStart', future: true }, revision));
    assert.equal(chats.get('chat').meta.unread, true);
    c.onCodexMessage(changed('chat', null, revision + ':read'));
    assert.equal(chats.get('chat').meta.unread, false);
  }
  c.onCodexMessage(changed('chat', { type: 'turn', turnId: '', future: {} }));
  assert.equal(chats.get('chat').meta.unread, true);
});

test('malformed required fields never become a read-clear or unread write', () => {
  const { c, chats } = setup();
  chats.ensure('chat');
  const valid = changed('chat', null).params;
  const bad: any[] = [
    null,
    undefined,
    [],
    false,
    'text',
    {},
    { ...valid, threadId: null },
    { ...valid, threadId: 1 },
    { threadId: 'chat', readState: null },
    { threadId: 'chat', readState: [] },
    { threadId: 'chat', readState: {} },
    { threadId: 'chat', readState: { revision: 1, firstUnread: null } },
    { threadId: 'chat', readState: { revision: null, firstUnread: null } },
    ...[undefined, false, true, [], 'turn', {}, { type: 'unknown' }, { type: 'turn' }, { type: 'turn', turnId: 1 }].map((firstUnread) => ({
      threadId: 'chat',
      readState: { revision: 'r', firstUnread },
    })),
  ];
  for (const params of bad) {
    assert.equal(readStateUnread(params), null);
    chats.patchMeta('chat', { unread: true });
    c.onCodexMessage(codex('thread/readState/changed', params));
    assert.equal(chats.get('chat').meta.unread, true);
    chats.patchMeta('chat', { unread: false });
    c.onCodexMessage(codex('thread/readState/changed', params));
    assert.equal(chats.get('chat').meta.unread, false);
  }
});

test('unknown and deleted threads never materialize either a chat or live session', () => {
  const { c, chats, state } = setup();
  for (const firstUnread of [null, { type: 'threadStart' }]) c.onCodexMessage(changed('unknown', firstUnread));
  assert.equal(chats.records.size, 0);
  assert.equal(state.has('unknown'), false);
  chats.ensure('deleted');
  chats.records.delete('deleted');
  c.onCodexMessage(changed('deleted', { type: 'threadStart' }));
  assert.equal(chats.records.has('deleted'), false);
});

test('retired native segments and switched Claude or ACP owners keep MoPilot unread state', () => {
  const { c, chats } = setup();
  for (const [kind, native] of [
    ['codex', 'next'],
    ['claude', 'new-claude'],
    ['acp:kimi', 'new-acp'],
  ]) {
    selectSegment(c, chats, 'stable', [
      ['codex', 'old'],
      [kind, native],
    ]);
    chats.patchMeta('stable', { unread: true });
    c.onCodexMessage(changed('old', null));
    assert.equal(chats.get('stable').meta.unread, true);
    if (kind !== 'codex') {
      c.onCodexMessage(changed(c.ref('stable').key, null));
      assert.equal(chats.get('stable').meta.unread, true);
    }
  }
});

test('a reused native id resolves its current stable owner without clearing an older chat', () => {
  const { c, chats } = setup();
  selectSegment(c, chats, 'first', [
    ['codex', 'native'],
    ['codex', 'replacement'],
  ]);
  selectSegment(c, chats, 'second', [
    ['claude', 'second'],
    ['codex', 'native'],
  ]);
  chats.patchMeta('first', { unread: true });
  chats.patchMeta('second', { unread: true });
  c.onCodexMessage(changed('native', null));
  assert.equal(chats.get('first').meta.unread, true);
  assert.equal(chats.get('second').meta.unread, false);
});

for (const turn of ['running', 'awaitingUser', 'external']) {
  test(`a read-clear during ${turn} output is discarded, never replayed at completion`, () => {
    const { c, chats, state } = setup();
    chats.ensure('chat');
    chats.patchMeta('chat', { unread: true });
    state.patch('chat', turn === 'external' ? { runningElsewhere: true } : { turn, activeTurn: { id: 'live', human: false } });
    c.viewing = () => true;
    c.onCodexMessage(changed('chat', null));
    assert.equal(chats.get('chat').meta.unread, true, 'focused is not proof the output was seen');
    state.patch('chat', { turn: 'idle', activeTurn: null, runningElsewhere: false });
    assert.equal(chats.get('chat').meta.unread, true);
    c.onCodexMessage(changed('chat', null, 'new-explicit-read'));
    assert.equal(chats.get('chat').meta.unread, false);
  });
}

test('server unread is accepted during streaming and repeated events do not write twice', () => {
  const { c, chats, state } = setup();
  chats.ensure('chat');
  state.patch('chat', { turn: 'running' });
  let changes = 0;
  chats.onChange = () => changes++;
  c.onCodexMessage(changed('chat', { type: 'threadStart' }));
  c.onCodexMessage(changed('chat', { type: 'threadStart' }));
  assert.equal(chats.get('chat').meta.unread, true);
  assert.equal(changes, 1);
});

test('adapter completions retire only their active owner in either settlement order, including malformed and failed events', () => {
  const a = new CodexAdapter({ server: { listeners: new Set() } });
  const start = (id: string) => a.onMessage(codex('turn/started', { threadId: 'native', turn: { id } }));
  const complete = (turn: unknown, threadId: unknown = 'native') => a.onMessage(codex('turn/completed', { threadId, turn }));
  for (const status of ['completed', 'failed', 'interrupted']) {
    start('first');
    complete({ id: 'first', status });
    assert.equal(a.running.has('native'), false);
    start('second');
    for (const turn of [null, {}, { id: 'first', status }, { id: 1, status }, { id: '', status }]) {
      complete(turn);
      assert.equal(a.running.has('native'), true);
      assert.equal(a.turnOf.get('native'), 'second');
    }
    complete({ id: 'second', status }, 'other-native');
    complete({ id: 'second', status }, null);
    assert.equal(a.running.has('native'), true);
    complete({ id: 'second', status });
    assert.equal(a.running.has('native'), false);
    assert.equal(a.turnOf.has('native'), false);
    // A late completion after both turns ended is harmless; a fresh lifecycle still works.
    complete({ id: 'first', status });
    start('third');
    complete({ id: 'second', status });
    assert.equal(a.turnOf.get('native'), 'third');
    complete({ id: 'third', status });
  }
  a.bookkeep('turn/completed', {});
});

test('replaced app-server/account process cannot clear a reused native thread through its retired pipe', () => {
  const { c, chats, state } = setup();
  chats.ensure('native');
  chats.patchMeta('native', { unread: true, account: 'old-account' });
  const processes: any[] = [];
  const server = new AppServer({
    findBin: () => 'fake-codex',
    spawn: () => {
      const proc = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {},
      });
      processes.push(proc);
      return proc;
    },
  });
  const a = new CodexAdapter({
    server,
    state,
    nativeOf: (id: string) => c.ref(id),
    chatOf: (id: string) => c.chatOf(id),
    observe: (message: any) => c.onCodexMessage(message),
  });
  c.codex = a;
  server.start();
  const publish = (index: number, message: any) => processes[index].stdout.write(JSON.stringify(message) + '\n');
  publish(0, codex('turn/started', { threadId: 'native', turn: { id: 'old-turn' } }));
  server.stop();
  chats.patchMeta('native', { account: 'new-account' });
  server.start();
  publish(1, codex('turn/started', { threadId: 'native', turn: { id: 'new-turn' } }));
  publish(0, codex('turn/completed', { threadId: 'native', turn: { id: 'old-turn' } }));
  publish(0, changed('native', null));
  assert.equal(a.turnOf.get('native'), 'new-turn');
  assert.equal(chats.get('native').meta.unread, true);
  publish(1, codex('turn/completed', { threadId: 'native', turn: { id: 'new-turn' } }));
  publish(0, changed('native', null));
  assert.equal(chats.get('native').meta.unread, true, 'retired account pipe remains retired after the new turn ends');
  publish(1, changed('native', null));
  assert.equal(chats.get('native').meta.unread, false);
  server.stop();
});

test('failed persistence preserves the authoritative unread state and publishes no false change', () => {
  const { c, chats } = setup();
  chats.ensure('chat');
  chats.patchMeta('chat', { unread: true });
  let changes = 0;
  chats.onChange = () => changes++;
  const file = chats.file('chat');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.doesNotThrow(() => c.onCodexMessage(changed('chat', null)));
  assert.equal(chats.get('chat').meta.unread, true);
  assert.equal(changes, 0);
  fs.rmdirSync(file);
  c.onCodexMessage(changed('chat', null, 'retry'));
  assert.equal(chats.get('chat').meta.unread, false);
  assert.equal(changes, 1);
});
