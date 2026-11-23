// The keyed stream batcher in main (electron/harness/coreBatcher.cjs) with every family's contract
// (core/crates/batcher, electron/harness/coreBatcher.cjs): joins, per-chat order, flush points, tick rate, the size bound.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CoreBatcher, WATCHED_MS, BACKGROUND_MS } = require('../electron/harness/coreBatcher.cjs');
/** The core's bound on a chat's pending text (core/crates/batcher `MAX_PENDING`). */
const MAX_PENDING = 256 * 1024;
const { familyChats } = require('../electron/harness/coreBatcher.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

/** session key -> chat; a key with no entry is its own chat (the controller's chatOf) */
let owners: Record<string, string> = {};
let sent: [string, any, any][] = [];
let watched = true;
/** every batcher a test made: the next test starts with none of their ticks pending */
const made: any[] = [];
const make = ({ prime = true, ...o }: any = {}) => {
  const b = new CoreBatcher({
    send: (family: string, event: any, target: any) => (sent.push([family, event, target]), true),
    watched: () => watched,
    ...o,
  });
  for (const [family, c] of Object.entries(familyChats({ chatOf: (key: string) => owners[key] ?? key }))) b.register(family, c);
  made.push(b);
  // a first delta goes out at once and starts the tick the others wait for: most tests are about what waits, so a delta
  // of a chat of its own starts it, and is forgotten (the leading edge has tests of its own)
  if (prime) {
    const before = sent.length;
    b.push('codex', codex('__prime__', 'prime', 'p'));
    sent.length = before;
  }
  return b;
};
beforeEach(() => {
  for (const b of made.splice(0)) b.cancel();
  owners = {};
  sent = [];
  watched = true;
});

const T = 'turn-1';
const codex = (chat: string, itemId: string, delta: any, method = 'item/agentMessage/delta', extra: any = {}) => ({
  kind: 'notification',
  chatId: chat,
  method,
  params: { threadId: chat, turnId: T, itemId, delta, ...extra },
});
const claude = (key: string, index: number, text: any, type = 'text_delta', extra: any = {}) => ({
  kind: 'message',
  key,
  msg: {
    type: 'stream_event',
    uuid: `u-${Math.random()}`,
    event: { type: 'content_block_delta', index, delta: type === 'thinking_delta' ? { type, thinking: text } : { type, text } },
    ...extra,
  },
});
const acp = (key: string, text: any, sessionUpdate = 'agent_message_chunk', extra: any = {}) => ({
  kind: 'update',
  key,
  turnId: T,
  update: { sessionUpdate, content: { type: 'text', text }, ...extra },
});
const textOf: Record<string, (e: any) => string> = {
  codex: (e) => e.params.delta,
  claude: (e) => e.msg.event.delta.text ?? e.msg.event.delta.thinking,
  acp: (e) => e.update.content.text,
};
/** each send as family:kind:text, the text of a delta (empty for other events) */
const shape = () =>
  sent.map(([family, e]) => {
    let text = '';
    try {
      text = textOf[family](e) ?? '';
    } catch {
      /* not a delta */
    }
    return `${family}:${e.kind}:${text}`;
  });

test('A/B/A/B across two chats of one family goes out once per key per tick, for every family', () => {
  const families: [string, (chat: string, text: string) => any][] = [
    ['codex', (chat, text) => codex(chat, 'm', text)],
    ['claude', (chat, text) => claude(chat, 0, text)],
    ['acp', (chat, text) => acp(chat, text)],
  ];
  for (const [family, delta] of families) {
    sent = [];
    const b = make();
    for (const text of ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']) assert.equal(b.push(family, delta(`chat-${text[0]}`, text)), true);
    assert.equal(sent.length, 0, 'nothing before the tick');
    mock.timers.tick(WATCHED_MS);
    const kind = delta('x', '').kind;
    assert.deepEqual(shape(), [`${family}:${kind}:a1a2a3`, `${family}:${kind}:b1b2b3`]);
    assert.ok(
      sent.every(([, , target]) => target === undefined),
      'to every window',
    );
  }
});

test('mixed families stream at once: each chat keeps its own queue', () => {
  const b = make();
  b.push('codex', codex('c1', 'm', 'x'));
  b.push('claude', claude('c2', 0, 'y'));
  b.push('acp', acp('c3', 'z'));
  b.push('codex', codex('c1', 'm', 'x'));
  b.push('claude', claude('c2', 0, 'y'));
  b.push('acp', acp('c3', 'z'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['codex:notification:xx', 'claude:message:yy', 'acp:update:zz']);
});

test('a non-delta event sends its chat pending deltas first, then itself at once; other chats keep waiting', () => {
  const b = make();
  b.push('claude', claude('c', 0, 'He'));
  b.push('claude', claude('other', 0, 'wait'));
  b.push('claude', claude('c', 0, 'llo'));
  b.push('claude', { kind: 'permission', key: 'c', requestId: 'r1' });
  assert.deepEqual(shape(), ['claude:message:Hello', 'claude:permission:']);
  b.push('claude', claude('c', 0, ' again'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape().slice(2), ['claude:message:wait', 'claude:message: again']);
});

test("only runs of one key join: a chat's deltas never change places", () => {
  const b = make();
  b.push('codex', codex('c', 'r', 'think', 'item/reasoning/summaryTextDelta', { summaryIndex: 0 }));
  b.push('codex', codex('c', 'm', 'say'));
  b.push('codex', codex('c', 'r', 'more', 'item/reasoning/summaryTextDelta', { summaryIndex: 0 }));
  b.push('codex', codex('c', 'r', 'part2', 'item/reasoning/summaryTextDelta', { summaryIndex: 1 }));
  b.push('codex', codex('c', 'r', 'raw', 'item/reasoning/textDelta', { contentIndex: 0 }));
  b.push('codex', codex('c', 'x', 'out', 'item/commandExecution/outputDelta'));
  b.push('codex', codex('c', 'p', 'plan', 'item/plan/delta'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), [
    'codex:notification:think',
    'codex:notification:say',
    'codex:notification:more',
    'codex:notification:part2',
    'codex:notification:raw',
    'codex:notification:out',
    'codex:notification:plan',
  ]);
});

test('Claude: thinking and text, block indices, accounts and sub-agents keep apart; other stream events are keyless', () => {
  const b = make();
  b.push('claude', claude('c', 0, 't1', 'thinking_delta'));
  b.push('claude', claude('c', 0, 't2', 'thinking_delta'));
  b.push('claude', claude('c', 1, 'x'));
  b.push('claude', claude('c', 2, 'y'));
  b.push('claude', { ...claude('c', 2, 'z'), account: 'other' });
  b.push('claude', { ...claude('c', 2, 'w'), account: 'other', login: false });
  assert.equal(sent.length, 0);
  // a sub-agent's delta, a block start, a malformed index or delta: sent at once, after what was pending
  b.push('claude', claude('c', 2, 'sub', 'text_delta', { parent_tool_use_id: 'tool' }));
  assert.deepEqual(shape(), [
    'claude:message:t1t2',
    'claude:message:x',
    'claude:message:y',
    'claude:message:z',
    'claude:message:w',
    'claude:message:sub',
  ]);
  for (const odd of [
    { kind: 'message', key: 'c', msg: { type: 'stream_event', event: { type: 'content_block_start', index: 3 } } },
    { kind: 'message', key: 'c', msg: { type: 'stream_event', event: null } },
    { kind: 'message', key: 'c', msg: null },
    claude('c', 1.5, 'q'),
    claude('c', 1, 42),
    claude('c', 1, 'q', 'input_json_delta'),
  ]) {
    sent = [];
    b.push('claude', odd);
    assert.equal(sent.length, 1, JSON.stringify(odd));
  }
  // an event with no session but a chat id (main's adapter) still flushes that chat
  b.push('claude', claude('c', 0, 'pending'));
  sent = [];
  b.push('claude', { kind: 'goalNotice', chatId: 'c', status: 'complete', body: '' });
  assert.deepEqual(shape(), ['claude:message:pending', 'claude:goalNotice:']);
  sent = [];
  b.push('claude', { kind: 'toast', level: 'info', text: 'no chat' });
  assert.equal(sent.length, 1);
});

test('ACP: message and thought chunks of one turn join; tool calls, nested agents and non-text content do not', () => {
  const b = make();
  b.push('acp', acp('k', 'a'));
  b.push('acp', acp('k', 'b'));
  b.push('acp', acp('k', 'th', 'agent_thought_chunk'));
  b.push('acp', acp('k', 'c'));
  b.push('acp', acp('k', 'n1', 'agent_message_chunk', { _meta: { claudeCode: { parentToolUseId: 'agent-1' } } }));
  b.push('acp', acp('k', 'n2', 'agent_message_chunk', { _meta: { claudeCode: { parentToolUseId: 'agent-1' } } }));
  b.push('acp', { ...acp('k', 'nt'), turnId: undefined });
  b.push('acp', acp('k', 'tc', 'agent_message_chunk', { toolCallId: 'call-1' }));
  assert.equal(sent.length, 0);
  // a tool call waits behind them (tests/streamBatcherWaits.test.ts); the flush sends all in order
  b.push('acp', { kind: 'update', key: 'k', turnId: T, update: { sessionUpdate: 'tool_call', toolCallId: 'x' } });
  assert.equal(sent.length, 0);
  b.flushNamed(['k']);
  assert.deepEqual(shape(), [
    'acp:update:ab',
    'acp:update:th',
    'acp:update:c',
    'acp:update:n1n2',
    'acp:update:nt',
    'acp:update:tc',
    'acp:update:',
  ]);
  for (const odd of [
    { kind: 'update', key: 'k', turnId: T, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '' } } },
    { kind: 'update', key: 'k', turnId: T, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 7 } } },
    { kind: 'update', key: 'k', turnId: T, update: { sessionUpdate: 'agent_message_chunk', content: [] } },
    { kind: 'update', key: 'k', turnId: T, update: null },
    {
      kind: 'update',
      key: 'k',
      turnId: { odd: true },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    },
    { kind: 'turnEnd', key: 'k' },
  ]) {
    sent = [];
    b.push('acp', odd);
    // an update that is not a joinable chunk waits for the tick, in order; anything else goes at once
    const waits = odd.kind === 'update' && odd.update !== null;
    if (waits) b.flushNamed(['k']);
    assert.equal(sent.length, 1, JSON.stringify(odd));
  }
});

test('Codex: malformed deltas, other methods and events outside a chat go out at once', () => {
  const b = make();
  for (const odd of [
    codex('c', 'm', 42),
    codex('c', 'r', 'x', 'item/reasoning/summaryTextDelta', { summaryIndex: -1 }),
    codex('c', { id: 7 } as any, 'x'),
    codex('c', 'm', 'x', 'item/fileChange/patchUpdated'),
    { kind: 'turnStarted', chatId: 'c' },
    { kind: 'toast', level: 'info', text: 'hi' },
    { kind: 'notification', method: 'account/updated', params: {} },
  ]) {
    sent = [];
    b.push('codex', odd);
    assert.equal(sent.length, 1, JSON.stringify(odd));
  }
  // a chat id from the thread when main gave none
  b.push('codex', { ...codex('t', 'm', 'a'), chatId: undefined });
  b.push('codex', { kind: 'request', chatId: 't' });
  assert.deepEqual(shape().slice(-2), ['codex:notification:a', 'codex:request:']);
});

test('a delta for one window is sent at once, after its chat pending deltas', () => {
  const b = make();
  b.push('codex', codex('c', 'm', 'a'));
  assert.equal(b.push('codex', codex('c', 'm', 'b'), 'any'), true);
  assert.deepEqual(
    sent.map(([, e, target]) => [e.params.delta, target]),
    [
      ['a', undefined],
      ['b', 'any'],
    ],
  );
});

test('a switch mid-stream: the old segment flushes before the new segment, whose deltas share the chat queue', () => {
  const b = make();
  owners = { 'claude-session': 'chat', 'codex-thread': 'chat' };
  b.push('claude', claude('claude-session', 0, 'old'));
  b.push('claude', claude('claude-session', 0, ' text'));
  // the new segment's first delta queues behind the old segment's, then its first event sends both, in order
  b.push('codex', { ...codex('chat', 'm', 'new'), params: { threadId: 'codex-thread', turnId: T, itemId: 'm', delta: 'new' } });
  assert.equal(sent.length, 0);
  b.push('codex', { kind: 'turnStarted', chatId: 'chat' });
  assert.deepEqual(shape(), ['claude:message:old text', 'codex:notification:new', 'codex:turnStarted:']);
  // and the explicit flush point (SwitchRunner's claim) sends what the old segment left
  b.push('acp', acp('claude-session', 'acp'));
  b.flushChat('chat');
  assert.deepEqual(shape().at(-1), 'acp:update:acp');
  b.flushChat('chat');
  b.flushChat('nothing pending');
});

test('the tick is a frame while an app window is on screen, the background rate otherwise', () => {
  watched = false;
  const b = make();
  b.push('codex', codex('c', 'm', 'a'));
  mock.timers.tick(WATCHED_MS);
  assert.equal(sent.length, 0);
  mock.timers.tick(BACKGROUND_MS - WATCHED_MS);
  assert.equal(sent.length, 1);
  // that tick sent something, so the next one runs: another background tick, read when it starts
  watched = true;
  mock.timers.tick(BACKGROUND_MS);
  b.push('codex', codex('c', 'm', 'b'));
  assert.equal(sent.length, 2, 'a quiet tick ended the cooldown: the delta after the pause goes out at once');
  b.push('codex', codex('c', 'm', 'c'));
  b.push('codex', codex('c', 'm', 'd'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['codex:notification:a', 'codex:notification:b', 'codex:notification:cd']);
  // a visibility check that throws counts as background
  const odd = make({
    watched: () => {
      throw new Error('gone');
    },
  });
  odd.push('codex', codex('o', 'm', 'x'));
  mock.timers.tick(WATCHED_MS);
  assert.equal(sent.length, 3);
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(sent.length, 4);
  assert.deepEqual(shape().at(-1), 'codex:notification:x');
});

test('a chat whose pending text passes the bound goes out at once', () => {
  const b = make({ maxPending: 10 });
  b.push('acp', acp('k', '12345'));
  b.push('acp', acp('other', 'x'));
  assert.equal(sent.length, 0);
  b.push('acp', acp('k', '67890'));
  assert.deepEqual(shape(), ['acp:update:1234567890']);
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['acp:update:1234567890', 'acp:update:x']);
  assert.equal(MAX_PENDING, 256 * 1024);
  // the default bound
  sent = [];
  const big = make();
  big.push('codex', codex('c', 'm', 'x'.repeat(MAX_PENDING - 1)));
  assert.equal(sent.length, 0);
  big.push('codex', codex('c', 'm', 'y'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].params.delta.length, MAX_PENDING);
});

test('flushAll sends every chat and stops the tick; a failing send drops none of the rest', () => {
  let fail = true;
  const b = make({
    send: (family: string, event: any, target: any) => {
      if (fail && textOf[family]?.(event) === 'boom') throw new Error('window gone');
      sent.push([family, event, target]);
      return true;
    },
  });
  b.push('codex', codex('a', 'm', 'boom'));
  b.push('codex', codex('a', 'x', 'kept'));
  b.push('claude', claude('b', 0, 'also'));
  b.flushAll();
  assert.deepEqual(shape(), ['codex:notification:kept', 'claude:message:also']);
  mock.timers.tick(BACKGROUND_MS);
  assert.equal(sent.length, 2, 'no tick left');
  fail = false;
  b.flushAll();
});

test('an event whose chat cannot be read sends every chat first; an unknown family goes straight out', () => {
  const b = make();
  b.push('codex', codex('a', 'm', 'first'));
  const odd = {
    kind: 'message',
    get key() {
      throw new Error('bad');
    },
  };
  b.push('claude', odd);
  assert.deepEqual(shape(), ['codex:notification:first', 'claude:message:']);
  assert.equal(b.push('other', { kind: 'x' }), true);
  assert.equal(sent.at(-1)![0], 'other');
  assert.deepEqual(b.families(), ['codex', 'claude', 'acp']);
  assert.throws(() => b.register('codex', () => null), /already registered/);
  assert.throws(() => b.register('nope', () => null), /no stream contract for nope/);
});

test('the default timers are the global ones', () => {
  const b = new CoreBatcher({ send: (f: string, e: any) => (sent.push([f, e, undefined]), true) });
  b.register('codex', familyChats({ chatOf: (k: string) => k }).codex);
  b.push('codex', codex('c', 'm', 'a'));
  mock.timers.tick(WATCHED_MS);
  assert.equal(sent.length, 1);
});

test('keys are structured: ids holding the separator or quotes never join another key', () => {
  const b = make();
  // one chat for both ACP sessions, so only the key keeps their deltas apart
  owners = { 'k\u0000a': 'k' };
  b.push('codex', { ...codex('c', 'a","b', 'x'), params: { threadId: 'c', turnId: 't","u', itemId: 'v', delta: 'x' } });
  b.push('codex', { ...codex('c', 'a","b', 'y'), params: { threadId: 'c', turnId: 't', itemId: 'u","v', delta: 'y' } });
  b.push('acp', acp('k\u0000a', 'p'));
  b.push('acp', { ...acp('k', 'q'), turnId: `a\u0000${T}` });
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(shape(), ['codex:notification:x', 'codex:notification:y', 'acp:update:p', 'acp:update:q']);
});

test('orderedReplies: a matching handler flushes before its answer or failure goes out; others are left as they are', async () => {
  const { orderedReplies } = require('../electron/harness/coreBatcher.cjs');
  const handlers = new Map<string, any>();
  const log: string[] = [];
  const ipc = {
    tag: 'ipc',
    handle(ch: string, fn: any) {
      handlers.set(ch, fn);
    },
    handleOnce(ch: string, fn: any) {
      handlers.set(ch, fn);
    },
    removeHandler(this: any, ch: string) {
      log.push(`remove ${ch} ${this.tag}`);
    },
  };
  const ordered = orderedReplies(ipc, async (fn: any) => {
    try {
      return await fn();
    } finally {
      log.push('flush');
    }
  });
  ordered.handle('codex:read', async (_e: any, x: number) => (log.push('read'), x * 2));
  ordered.handleOnce('codex:fail', () => {
    throw new Error('no');
  });
  ordered.handle('other', () => 'sync');
  orderedReplies(ipc, async () => log.push('never'), /^none:/).handle('codex:plain', () => 'plain');
  assert.equal(handlers.get('codex:plain')({}), 'plain');
  assert.equal(await handlers.get('codex:read')({}, 21), 42);
  await assert.rejects(handlers.get('codex:fail')({}), /no/);
  assert.equal(handlers.get('other')({}), 'sync');
  ordered.removeHandler('x');
  assert.equal(ordered.tag, 'ipc');
  assert.deepEqual(log, ['read', 'flush', 'flush', 'remove x ipc']);
});
