// A batcher flush reaches each window as one message, and a live diff only the windows that show its chat
// (electron/app/windows.cjs), over fake windows.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { createWindows } = require('../electron/app/windows.cjs');
const { BACKGROUND_MS } = require('../electron/harness/coreBatcher.cjs');
const { STREAM_BATCH, streamItems } = require('../electron/bridge/spec.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

const delta = (chat: string, text: string) => ({
  kind: 'message',
  key: chat,
  msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
});

function setup() {
  let ids = 0;
  const log: Record<number, [string, any, any?][]> = {};
  const state = { destroyed: new Set<number>(), failing: new Set<number>() };
  class Win extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      id: ++ids,
      send: (channel: string, payload: any, cloned?: any) => {
        if (state.failing.has(this.webContents.id)) throw new Error('gone');
        // a stream batch is unpacked as the preload does: its JSON bytes and what was cloned beside them
        (log[this.webContents.id] ??= []).push([channel, channel === STREAM_BATCH ? streamItems(payload, cloned) : payload, payload]);
      },
      isDestroyed: () => state.destroyed.has(this.webContents.id),
      setWindowOpenHandler: () => {},
    });
    isDestroyed = () => state.destroyed.has(this.webContents.id);
    isVisible = () => true;
    isMinimized = () => false;
    isFocused = () => false;
    loadFile() {}
    show() {}
  }
  const live: any = { chats: { get: () => ({}) } };
  const w = createWindows({
    BrowserWindow: Win,
    webContents: { fromId: () => null },
    nativeTheme: {},
    windowReadiness: { forget() {} },
    live,
    isDev: false,
    isWin: false,
    zoom: { chromeOptions: () => ({}), attach() {} },
  } as any);
  w.createWindow('', { hidden: true });
  w.createWindow('', { hidden: true });
  return { w, log, state, ids: () => [1, 2] };
}

const tickOut = () => mock.timers.tick(BACKGROUND_MS * 2);

test("one tick's deltas for several chats reach a window as one stream batch, in each chat's order", () => {
  const { w, log } = setup();
  w.claudeEmit(delta('c1', 'lead1'));
  for (const id of [1, 2])
    assert.deepEqual(
      log[id].map(([c]) => c),
      ['claude:event'],
      'the leading edge',
    );
  log[1].length = 0;
  log[2].length = 0;
  w.claudeEmit(delta('c1', 'a'));
  w.claudeEmit(delta('c1', 'b'));
  w.claudeEmit(delta('c2', 'x'));
  assert.equal(log[1].length, 0, 'held for the tick');
  tickOut();
  for (const id of [1, 2]) {
    assert.equal(log[id].length, 1, `window ${id}: one message`);
    const [channel, items] = log[id][0];
    assert.equal(channel, STREAM_BATCH);
    assert.deepEqual(
      items.map(([c, e]: any) => [c, e.key, e.msg.event.delta.text]),
      [
        ['claude:event', 'c1', 'ab'],
        ['claude:event', 'c2', 'x'],
      ],
    );
  }
});

test('a flush with a single event goes out as that event, and one for a destroyed or failing window is dropped quietly', () => {
  const { w, log, state } = setup();
  w.claudeEmit(delta('c1', 'lead'));
  log[1].length = 0;
  log[2].length = 0;
  w.claudeEmit(delta('c1', 'a'));
  state.failing.add(2);
  tickOut();
  assert.deepEqual(
    log[1].map(([c]) => c),
    ['claude:event'],
    'a lone event is not wrapped',
  );
  assert.equal(log[2].length, 0, 'the failing window lost its send, the other kept its own');
  state.failing.clear();
  w.claudeEmit(delta('c1', 'b'));
  w.claudeEmit(delta('c1', 'c'));
  w.claudeEmit(delta('c2', 'd'));
  state.destroyed.add(2);
  tickOut();
  assert.equal(log[2].length, 0);
  assert.equal(log[1].at(-1)![0], STREAM_BATCH);
});

test('events sent outside a flush are not held back, and a broadcast about another chat leaves a pending delta pending', () => {
  const { w, log } = setup();
  w.claudeEmit(delta('c1', 'lead'));
  w.claudeEmit(delta('c1', 'a'));
  log[1].length = 0;
  w.broadcastAll('chats:changed', { id: 'c2' });
  assert.deepEqual(
    log[1].map(([c]) => c),
    ['chats:changed'],
  );
  w.broadcastAll('chats:changed', { id: 'c1' });
  assert.deepEqual(
    log[1].map(([c]) => c),
    ['chats:changed', 'claude:event', 'chats:changed'],
    "c1's delta first",
  );
});

test('a live diff goes to the windows that show the chat and to those with no reported view', () => {
  const { w, log } = setup();
  w.viewedBy.set(1, { visible: ['c1'], primary: 'c1', focused: 'c1' });
  w.viewedBy.set(2, { visible: ['c2'], primary: 'c2', focused: 'c2' });
  w.sendToViewers('session:turnDiff', { chatId: 'c1', diff: 'd' });
  assert.deepEqual(
    log[1].map(([c]) => c),
    ['session:turnDiff'],
  );
  assert.equal(log[2]?.length ?? 0, 0);
  w.viewedBy.delete(2);
  w.sendToViewers('session:turnDiff', { chatId: 'c1', diff: 'e' });
  assert.equal(log[2].length, 1, 'a window that has not reported a view may show it');
});

test("a live diff goes after the chat's pending text, and skips a destroyed window", () => {
  const { w, log, state } = setup();
  w.claudeEmit(delta('c1', 'lead'));
  w.claudeEmit(delta('c1', 'a'));
  log[1].length = 0;
  log[2].length = 0;
  state.destroyed.add(2);
  w.sendToViewers('session:turnDiff', { chatId: 'c1', diff: 'd' });
  assert.deepEqual(
    log[1].map(([c]) => c),
    ['claude:event', 'session:turnDiff'],
  );
  assert.equal(log[2]?.length ?? 0, 0);
});

test('a batch started inside a batch joins it, and a window destroyed before the batch ends gets nothing', () => {
  const { w, log, state } = setup();
  w.streams.batch(() => {
    w.streams.batch(() => w.emitToWindows('claude:accounts', { n: 1 }));
    w.emitToWindows('claude:accounts', { n: 2 });
    assert.equal(log[1]?.length ?? 0, 0, 'held until the outer batch ends');
    state.destroyed.add(2);
  });
  assert.deepEqual(
    log[1].map(([c]) => c),
    [STREAM_BATCH],
  );
  assert.deepEqual(
    log[1][0][1].map(([, e]: any) => e.n),
    [1, 2],
  );
  assert.equal(log[2]?.length ?? 0, 0);
});

test("a deletion or reset broadcast sends every chat's pending text first", () => {
  const { w, log } = setup();
  w.claudeEmit(delta('c1', 'lead'));
  w.claudeEmit(delta('c1', 'a'));
  log[1].length = 0;
  w.broadcastAll('chats:deleted', { owner: 'c1', nativeKeys: ['claude:s1'] });
  assert.deepEqual(
    log[1].map(([c]) => c),
    ['claude:event', 'chats:deleted'],
  );
  w.claudeEmit(delta('c2', 'x'));
  w.claudeEmit(delta('c2', 'y'));
  log[1].length = 0;
  w.broadcastAll('chats:reset', {});
  assert.deepEqual(
    log[1].map(([c]) => c),
    ['claude:event', 'chats:reset'],
  );
});

const codex = (chat: string, text: string, origin: number | null = 1) => ({
  kind: 'notification',
  chatId: chat,
  origin,
  method: 'item/agentMessage/delta',
  params: { threadId: chat, turnId: 't', itemId: 'm', delta: text },
});

test("a flush of deltas is JSON bytes, with each window's own `mine` written into the text", () => {
  const { w, log } = setup();
  w.codexEmit(codex('c1', 'lead'));
  for (const id of [1, 2]) assert.equal(log[id][0][1].mine, id === 1, `window ${id}: the leading edge as an object`);
  log[1].length = 0;
  log[2].length = 0;
  w.codexEmit(codex('c1', 'a'));
  w.codexEmit(codex('c1', 'b'));
  w.codexEmit(codex('c2', 'x', null));
  tickOut();
  for (const id of [1, 2]) {
    const [[channel, items, raw]] = log[id];
    assert.equal(channel, STREAM_BATCH);
    assert.ok(raw instanceof Uint8Array && raw.byteOffset === 0 && raw.buffer.byteLength === raw.length, 'bytes of their own');
    assert.deepEqual(
      items.map(([c, e]: any) => [c, e.params.delta, e.mine]),
      [
        ['codex:item', 'ab', id === 1],
        ['codex:item', 'x', false],
      ],
    );
  }
});

test('a delta in a batch arrives as JSON reads it back; one sent alone is cloned as before', () => {
  const { w, log } = setup();
  const odd = (text: string) => ({ ...codex('c1', text), gone: undefined, zero: -0, when: new Date(0), nan: NaN });
  w.codexEmit(odd('lead'));
  const alone = log[1][0][1];
  assert.ok('gone' in alone && Object.is(alone.zero, -0) && alone.when instanceof Date && Number.isNaN(alone.nan), 'a clone');
  w.codexEmit(odd('a'));
  w.codexEmit(codex('c2', 'x'));
  tickOut();
  const [, items] = log[1].at(-1)!;
  const [, batched] = items[0];
  assert.equal('gone' in batched, false, 'undefined keys are left out');
  assert.ok(Object.is(batched.zero, 0), '-0 is 0');
  assert.equal(batched.when, '1970-01-01T00:00:00.000Z', 'a Date is its string');
  assert.equal(batched.nan, null, 'NaN is null');
});

test("session:patch never overtakes its chat's text, its waiting tool updates among it", () => {
  const { w, log } = setup();
  const update = (sessionUpdate: string, extra: any) => ({ kind: 'update', key: 'c1', turnId: 't', update: { sessionUpdate, ...extra } });
  w.acpEmit(update('agent_message_chunk', { content: { type: 'text', text: 'lead' } }));
  w.acpEmit(update('agent_message_chunk', { content: { type: 'text', text: 'a' } }));
  w.acpEmit(update('tool_call', { toolCallId: 'x' }));
  w.acpEmit(update('agent_message_chunk', { content: { type: 'text', text: 'b' } }));
  log[1].length = 0;
  w.broadcastAll('session:patch', { chatId: 'c1', rev: 2 });
  assert.deepEqual(
    log[1].map(([c]) => c),
    [STREAM_BATCH, 'session:patch'],
  );
  assert.ok(log[1][0][2] instanceof Uint8Array);
  assert.deepEqual(
    log[1][0][1].filter(([c]: any) => c === 'acp:event').map(([, e]: any) => e.update.content?.text ?? e.update.toolCallId),
    ['a', 'x', 'b'],
  );
});
