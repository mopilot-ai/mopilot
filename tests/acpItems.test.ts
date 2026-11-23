// A basic (ACP) chat's events translated once in main (electron/harness/items/acp.cjs): the notifications match what the
// shared translator makes of the same events, retired segments stay out, a stray turn closes when it goes quiet, usage
// reaches the context ring, and the history read keeps the running turn open with the live ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AcpItems, STRAY_MS } = require('../electron/harness/items/acp.cjs');
const { AcpTranslator } = require('../electron/harness/items/acpTranslator.cjs');

const KEY = 'acp:gemini:s1';
const user = { id: 'u1', clientId: 'c1', content: [{ type: 'text', text: 'hi' }] };
const turn = [
  { key: KEY, kind: 'turnStart', turnId: 't1', user, human: true, cwd: '/w' },
  { key: KEY, kind: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } },
  { key: KEY, kind: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } },
  {
    key: KEY,
    kind: 'update',
    turnId: 't1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'x',
      title: 'ls',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    },
  },
  { key: KEY, kind: 'update', turnId: 't1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' } },
  { key: KEY, kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn', error: null },
];

/** `value` without the clock's readings (startedAt, completedAt, durationMs), which differ between two runs. */
const untimed = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (k, v) => (['startedAt', 'completedAt', 'durationMs'].includes(k) ? undefined : v));

/** Main's items for `events`, and what it adds to each event, with the chat's current segment `current`. */
/** A reply of AcpItems.history as a window reads it. */
const turnsOf = async (reply: Promise<{ page: Uint8Array; activeTurnId: unknown }>) => {
  const { page, activeTurnId } = await reply;
  return { ...JSON.parse(new TextDecoder().decode(page)), activeTurnId };
};

function feed(
  events: any[],
  o: { current?: string; chat?: (key: string) => string; timers?: any; nativeOf?: (chat: string) => string } = {},
) {
  const out: any[] = [];
  const items = new AcpItems({
    chatOf: o.chat ?? (() => 'chat-1'),
    nativeOf: o.nativeOf ?? (() => o.current ?? KEY),
    cwdOf: () => '/w',
    emit: (chatId: string, key: string, method: string, params: any) => out.push({ chatId, key, method, params }),
    timers: o.timers,
  });
  const known = events.map((e) => items.onEvent(e));
  return { out, known, items };
}

test('main emits what the shared translator makes of the same events', () => {
  const expected: any[] = [];
  const tr = new AcpTranslator('chat-1', '/w', (method: string, params: any) => expected.push({ method, params }));
  tr.beginTurn('t1', user);
  for (const e of turn.slice(1, -1)) tr.onUpdate((e as any).update, 't1');
  tr.endTurn('end_turn', null, null);
  const { out, known } = feed(turn);
  assert.deepEqual(untimed(out.map(({ method, params }) => ({ method, params }))), untimed(expected));
  assert.ok(out.every((x) => x.chatId === 'chat-1' && x.key === KEY));
  assert.deepEqual(known.at(-1), { running: true }, 'the turn was running when it ended');
});

test("a retired segment's live events stay out of the chat's items; its other events still count", () => {
  const { out, known } = feed([...turn.slice(0, 2), { key: KEY, kind: 'session', fresh: true }], { current: 'acp:gemini:other' });
  assert.deepEqual(out, []);
  assert.deepEqual(known, [null, null, null]);
  assert.equal(feed([{ kind: 'update' }]).known[0], null, 'an event without a session key');
});

test('a repeated end offers nothing again, and a harness that quits while working ends its turn in error', () => {
  const ended = feed([...turn, { key: KEY, kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn', error: null }]);
  assert.deepEqual(ended.known.at(-1), { running: false });
  const quit = feed([...turn.slice(0, 2), { key: KEY, kind: 'closed', error: 'exited' }]);
  assert.deepEqual(quit.known.at(-1), { working: true });
  const done = quit.out.find((x) => x.method === 'turn/completed');
  assert.equal(done.params.turn.status, 'failed');
  assert.deepEqual(feed([{ key: KEY, kind: 'closed', error: 'exited' }]).known[0], { working: false }, 'nothing was running');
  assert.equal(feed([{ key: KEY, kind: 'permission' }]).known[0], null);
});

test('context and per-prompt usage reach the context ring once per turn; a fresh session starts again', () => {
  const usage = { key: KEY, kind: 'update', turnId: 't1', update: { sessionUpdate: 'usage_update', used: 500, size: 1000 } };
  const end = {
    key: KEY,
    kind: 'turnEnd',
    turnId: 't1',
    stopReason: 'end_turn',
    error: null,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
  const { out } = feed([turn[0], usage, end, end, { key: KEY, kind: 'session', fresh: true }, usage]);
  const reports = out.filter((x) => x.method === 'thread/tokenUsage/updated');
  assert.equal(reports.length, 3, 'the context reading, the turn once, the context again after the fresh session');
  assert.deepEqual(reports[0].params.tokenUsageSource, { harness: 'acp:gemini', nativeId: KEY });
  assert.equal(reports[0].params.tokenUsage.modelContextWindow, 1000);
  assert.equal(reports[1].params.tokenUsage.total.totalTokens, 15);
  assert.equal(reports[2].params.tokenUsage.total.totalTokens, 0, 'the fresh session counted from zero');
});

test('work with no prompt running gets a turn that closes once it goes quiet, unless it was replaced', () => {
  const pending: (() => void)[] = [];
  const timers = { set: (fn: () => void) => (pending.push(fn), pending.length), clear: () => {} };
  const stray = {
    key: KEY,
    kind: 'update',
    turnId: null,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
  };
  const { out, items } = feed([stray], { timers });
  assert.equal(pending.length, 1);
  assert.equal(STRAY_MS, 1500);
  pending[0]();
  assert.equal(out.at(-1).method, 'turn/completed');
  assert.equal(out.at(-1).params.turn.status, 'interrupted');
  // a stray turn a real prompt replaced is left to it
  items.onEvent(stray);
  items.onEvent(turn[0]);
  const before = out.length;
  pending.at(-1)!();
  assert.equal(out.length, before);
});

test('the translator follows the chat that owns the session: a new owner starts afresh', () => {
  let owner = 'chat-1';
  const { out, items } = feed([turn[0]], { chat: () => owner });
  owner = 'chat-2';
  assert.equal(items.get(KEY), undefined);
  items.onEvent({ ...turn[0], turnId: 't2' });
  assert.equal(out.at(-1).chatId, 'chat-2');
  // a stray timer of the old owner is dropped with it
  const pending: (() => void)[] = [];
  let cleared = 0;
  const timers = { set: (fn: () => void) => (pending.push(fn), 1), clear: () => cleared++ };
  let o = 'a';
  const f = feed(
    [{ key: KEY, kind: 'update', turnId: null, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } }],
    {
      chat: () => o,
      timers,
    },
  );
  o = 'b';
  f.items.get(KEY);
  assert.ok(cleared > 0);
});

test('history keeps the turn this session is running open, and ends one it no longer runs', async () => {
  const records = [
    { t: 'user', turnId: 't1', user, at: 1000 },
    { t: 'update', turnId: 't1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } }, at: 1100 },
  ];
  // chat-1's current segment is this session; another chat's is not
  const { items } = feed(turn.slice(0, 2), { nativeOf: (chat) => (chat === 'chat-1' ? KEY : 'acp:gemini:z') });
  const live = await turnsOf(items.history(KEY, 'chat-1', '/w', async () => ({ file: '', extra: records })));
  assert.equal(live.activeTurnId, 't1');
  assert.equal(live.turns.at(-1).status, 'inProgress');
  const other = await turnsOf(items.history(KEY, 'chat-other', '/w', async () => ({ file: '', extra: records })));
  assert.equal(other.activeTurnId, null);
  assert.equal(other.turns.at(-1).status, 'interrupted');
});

test("a turn a machine kept running while this app was closed goes on from where its transcript ends, whenever it's read", async () => {
  const chunk = (kind: string, text: string, messageId?: string) => ({
    key: KEY,
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: kind, messageId, content: { type: 'text', text } },
  });
  const tool = {
    sessionUpdate: 'tool_call',
    toolCallId: 'x',
    title: 'ls',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'ls' },
  };
  const records = [
    { t: 'user', turnId: 't1', user },
    { t: 'update', turnId: 't1', update: chunk('agent_message_chunk', 'the first message of the reply', 'a').update },
    { t: 'update', turnId: 't1', update: tool },
  ];
  const resumed = () => {
    const out: any[] = [];
    const items = new AcpItems({
      chatOf: () => 'chat-1',
      nativeOf: () => KEY,
      cwdOf: () => '/w',
      emit: (chatId: string, key: string, method: string, params: any) => out.push({ chatId, key, method, params }),
    });
    return { out, items };
  };
  const end = { key: KEY, kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn', error: null };
  // a window that read the chat before the machine said so, and one that reads it after
  for (const read of ['before', 'after']) {
    const { out, items } = resumed();
    if (read === 'before')
      assert.equal((await turnsOf(items.history(KEY, 'chat-1', '/w', async () => ({ file: '', extra: records })))).activeTurnId, null);
    items.onEvent({ ...turn[0], partway: { file: '', extra: records } });
    await items.followed;
    assert.deepEqual(
      out.map((x) => x.method),
      ['turn/started', 'item/completed'],
      'the windows hear of the turn',
    );
    if (read === 'after')
      assert.equal(
        (await turnsOf(items.history(KEY, 'chat-1', '/w', async () => ({ file: '', extra: records })))).turns.at(-1).status,
        'inProgress',
      );
    items.onEvent({
      key: KEY,
      kind: 'update',
      turnId: 't1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' },
    });
    const done = out.at(-1).params.item;
    assert.equal(done.id, 'x');
    assert.equal(done.command, 'ls', 'a tool call from before the restart keeps its card');
    items.onEvent(chunk('agent_message_chunk', 'the second message of the reply', 'b'));
    items.onEvent(end);
    assert.equal(out.at(-2).params.item.id, 't1:m1', read);
    assert.equal(out.at(-2).params.item.text, 'the second message of the reply');
    assert.equal(out.at(-1).method, 'turn/completed');
    assert.ok(out.every((x) => x.chatId === 'chat-1' && x.key === KEY));
  }
  // text it streams after that stays whole when a window then reads the transcript, which never held it
  const { out, items } = resumed();
  items.onEvent({ ...turn[0], partway: { file: '', extra: records } });
  await items.followed;
  const own = items.get(KEY);
  items.onEvent(chunk('agent_message_chunk', 'text only streamed so far, not yet written', 'b'));
  await items.history(KEY, 'chat-1', '/w', async () => ({ file: '', extra: records }));
  assert.equal(items.get(KEY), own);
  items.onEvent(chunk('agent_message_chunk', ' and the rest', 'b'));
  items.onEvent(end);
  assert.equal(
    out.findLast((x) => x.params.item?.id === 't1:m1').params.item.text,
    'text only streamed so far, not yet written and the rest',
  );
  // a transcript that doesn't end in that turn leaves the translator that began it
  const other = feed([{ ...turn[0], turnId: 't9', partway: { file: '', extra: records } }]);
  await other.items.followed;
  other.items.onEvent(chunk('agent_message_chunk', 'first of its own', 't9'));
  assert.equal(other.items.get(KEY).turnId, 't9');
  assert.ok(other.out.some((x) => x.params.itemId === 't9:m0' || x.params.item?.id === 't9:m0'));
});

test('a transcript carried for main never goes on to the windows', async () => {
  const sent: any[] = [];
  const send = (_channel: string, event: any) => (sent.push(event), true);
  const { acpSender } = require('../electron/harness/items/acp.cjs');
  const s = acpSender({ controller: { chatOf: () => 'chat-1', nativeOf: () => KEY } }, send);
  s.send({ ...turn[0], partway: { file: '', extra: [{ t: 'user', turnId: 't1', user }] } });
  await s.items.followed;
  const told = sent.find((e) => e.kind === 'turnStart');
  assert.equal(told.partway, undefined);
  assert.equal(told.turnId, 't1');
  s.send(turn.at(-1));
  assert.equal(sent.at(-1).running, true);
});

test('one that heard the turn from its start keeps its own translator through a read', async () => {
  const whole = feed(turn.slice(0, 2));
  const own = whole.items.get(KEY);
  await whole.items.history(KEY, 'chat-1', '/w', async () => ({ file: '', extra: [{ t: 'user', turnId: 't1', user }] }));
  assert.equal(whole.items.get(KEY), own);
});

test("main's services: the controller maps sessions to chats and the host knows their folders, before either exists too", async () => {
  const out: any[] = [];
  const emit = (chatId: string, key: string, method: string, params: any) => out.push({ chatId, key, method, params });
  const bare = AcpItems.of({}, emit);
  bare.onEvent(turn[0]);
  assert.equal(out.length, 0, 'no controller yet: the session is its own chat, with no current segment to show it in');
  const live = {
    controller: { chatOf: (key: string) => (key === KEY ? 'chat-9' : undefined), nativeOf: () => KEY },
    acpHost: { chats: new Map([[KEY, { cwd: '/repo' }]]) },
  };
  const items = AcpItems.of(live, emit);
  items.onEvent(turn[0]);
  assert.equal(out.at(-1).chatId, 'chat-9');
  assert.equal(items.get(KEY).cwd, '/repo');
  // a session the controller doesn't map is its own chat; a host without its folder gives none
  const other = AcpItems.of({ controller: { chatOf: () => undefined, nativeOf: () => 'acp:gemini:z' }, acpHost: {} }, emit);
  other.onEvent({ ...turn[0], key: 'acp:gemini:z' });
  assert.equal(out.at(-1).chatId, 'acp:gemini:z');
  // a history read for the current session before it has a translator: no turn running
  const fresh = AcpItems.of(live, emit);
  assert.equal((await fresh.history(KEY, 'chat-9', '/repo', async () => ({ file: '', extra: [] }))).activeTurnId, null);
});
