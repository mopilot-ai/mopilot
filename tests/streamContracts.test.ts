// Every harness family has a stream contract in the core (core/crates/batcher) and a chat for its events
// (electron/harness/coreBatcher.cjs `familyChats`), and every family's emitter in electron/app/windows.cjs holds its
// deltas for the tick: a new family cannot skip batching.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { familyChats, BACKGROUND_MS } = require('../electron/harness/coreBatcher.cjs');
const { MAIN_TRAITS } = require('../electron/harness/family.cjs');
const { createWindows } = require('../electron/app/windows.cjs');
const { core } = require('../electron/platform/core.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

test('the contract registry covers every harness family, each with a chat and a contract in the core', () => {
  const chats = familyChats({ chatOf: (key: string) => key });
  assert.deepEqual(Object.keys(chats).sort(), Object.keys(MAIN_TRAITS).sort());
  const contracts = JSON.parse(String(core().dispatchSync('batcher.families', Buffer.alloc(0))));
  for (const [family, chatOf] of Object.entries<any>(chats)) {
    assert.equal(typeof chatOf, 'function', `${family} has a chat`);
    assert.ok(contracts[family]?.delta.length, `${family} has a contract in the core`);
  }
  // the remote item feed's own stream (electron/harness/remoteItemFeed.cjs) has one too
  assert.deepEqual(Object.keys(contracts).sort(), [...Object.keys(MAIN_TRAITS), 'feed'].sort());
});

/** One text delta of each family, in the shape its adapter emits. */
const DELTAS: Record<string, any> = {
  codex: {
    kind: 'notification',
    chatId: 'c',
    method: 'item/agentMessage/delta',
    params: { threadId: 'c', turnId: 't', itemId: 'm', delta: 'x' },
  },
  claude: {
    kind: 'message',
    key: 'c',
    msg: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
  },
  acp: { kind: 'update', key: 'c', turnId: 't', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } },
};

test("every family's emitter to windows holds its deltas for the tick, and a broadcast sends them first", () => {
  const sent: string[] = [];
  class Win extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      id: 1,
      send: (channel: string) => sent.push(channel),
      isDestroyed: () => false,
      setWindowOpenHandler: () => {},
    });
    isDestroyed = () => false;
    isVisible = () => false;
    isFocused = () => false;
    loadFile() {}
    show() {}
  }
  const w = createWindows({
    BrowserWindow: Win,
    webContents: { fromId: () => null },
    nativeTheme: {},
    windowReadiness: { forget() {} },
    live: {},
    isDev: false,
    isWin: false,
    zoom: { chromeOptions: () => ({}), attach() {} },
  } as any);
  w.createWindow('', { hidden: true });
  assert.deepEqual(Object.keys(DELTAS).sort(), Object.keys(MAIN_TRAITS).sort(), 'a delta for every family');
  for (const family of Object.keys(MAIN_TRAITS)) {
    sent.length = 0;
    // the broadcast below leaves the tick running; let it run out so this family's first delta leads
    mock.timers.tick(BACKGROUND_MS * 2);
    const emit = (w as any)[`${family}Emit`];
    assert.equal(typeof emit, 'function', `${family} has an emitter`);
    emit(DELTAS[family]);
    assert.equal(sent.length, 1, `${family}: the first delta goes out at once`);
    emit(DELTAS[family]);
    emit(DELTAS[family]);
    assert.equal(sent.length, 1, `${family}: held for the tick`);
    mock.timers.tick(BACKGROUND_MS);
    assert.equal(sent.length, 2, `${family}: joined into one send`);
    emit(DELTAS[family]);
    assert.equal(sent.length, 2, `${family}: held again, inside the next tick`);
    // a broadcast about another chat leaves it pending; one that names the chat sends it first
    w.broadcastAll('session:patch', { chatId: 'other' });
    assert.equal(sent.length, 3, `${family}: only the broadcast went out`);
    w.broadcastAll('session:patch', { chatId: 'c' });
    assert.equal(sent.at(-1), 'session:patch');
    assert.equal(sent.length, 5, `${family}: the pending delta went first`);
  }
  // any other channel through emitToWindows also goes after what is pending
  mock.timers.tick(BACKGROUND_MS * 2);
  w.codexEmit(DELTAS.codex);
  w.codexEmit(DELTAS.codex);
  w.emitToWindows('claude:accounts', { chatId: 'c' });
  w.broadcastExcept('chats:changed', null, { chatId: 'c' });
  assert.deepEqual(sent.slice(-4), ['codex:item', 'codex:item', 'claude:accounts', 'chats:changed']);
});
