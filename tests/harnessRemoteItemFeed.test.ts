// The remote item feed (electron/harness/remoteItemFeed.cjs): one item shape for a streamed reply and a tool call from every family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createItemFeed, RING, TICK_MS } = require('../electron/harness/remoteItemFeed.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

/** Timers that run only when a test says so. */
function manualTimers() {
  const waiting: { fn: () => void; ms: number }[] = [];
  return {
    waiting,
    setTimeout: ((fn: () => void, ms: number) => (waiting.push({ fn, ms }), waiting.length)) as any,
    clearTimeout: (() => {}) as any,
    tick() {
      for (const t of waiting.splice(0)) t.fn();
    },
  };
}
function make(o: any = {}) {
  const events: any[] = [];
  const timers = manualTimers();
  const feed = createItemFeed({ emit: (e: any) => events.push(e), batcher: { timers }, ...o });
  return { feed, events, timers };
}

const cmd = (id: string, status: string, output: string | null) => ({
  type: 'commandExecution',
  id,
  command: 'ls',
  cwd: '',
  processId: null,
  source: 'agent',
  status,
  commandActions: [],
  aggregatedOutput: output,
  exitCode: output === null ? null : 0,
  durationMs: null,
  pluginId: null,
  scriptPath: null,
});
const msg = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null });

const claudeMsg = (m: any) => ({ kind: 'message', key: 'k', msg: m });
const stream = (event: any) => claudeMsg({ type: 'stream_event', event });
/** The same exchange per family: a reply "Hello" streamed in two chunks, then `ls` started and completed. */
const FIXTURES: Record<string, any[]> = {
  codex: [
    { method: 'turn/started', params: { threadId: 'c', turn: { id: 't', status: 'inProgress' } } },
    { method: 'item/started', params: { threadId: 'c', turnId: 't', item: msg('m', '') } },
    { method: 'item/agentMessage/delta', params: { threadId: 'c', turnId: 't', itemId: 'm', delta: 'Hel' } },
    { method: 'item/agentMessage/delta', params: { threadId: 'c', turnId: 't', itemId: 'm', delta: 'lo' } },
    { method: 'item/completed', params: { threadId: 'c', turnId: 't', item: msg('m', 'Hello') } },
    { method: 'item/started', params: { threadId: 'c', turnId: 't', item: cmd('x', 'inProgress', null) } },
    { method: 'item/completed', params: { threadId: 'c', turnId: 't', item: cmd('x', 'completed', 'a.txt') } },
    { method: 'turn/completed', params: { threadId: 'c', turn: { id: 't', status: 'completed' } } },
  ],
  claude: [
    { kind: 'turnStarting', turnId: 't', clientId: 'q', text: 'hi' },
    stream({ type: 'message_start', message: { id: 'm1' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    claudeMsg({
      type: 'assistant',
      uuid: 'a',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    claudeMsg({
      type: 'user',
      uuid: 'u',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a.txt' }] },
    }),
    claudeMsg({ type: 'result', subtype: 'success', is_error: false, result: 'Hello' }),
  ],
  acp: [
    { kind: 'turnStart', turnId: 't', user: { id: 'u', content: [] } },
    { kind: 'update', turnId: 't', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } },
    { kind: 'update', turnId: 't', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } },
    {
      kind: 'update',
      turnId: 't',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'x',
        title: 'ls',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      },
    },
    {
      kind: 'update',
      turnId: 't',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'x',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
      },
    },
    { kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' },
  ],
};

/** What a follower sees after the exchange: the items it holds, with the stream's events applied. */
function followerView(events: any[]) {
  const items: any[] = [];
  for (const e of events) {
    if (e.ev === 'items.append') items.push(...e.items);
    else if (e.ev === 'items.replace') for (const i of e.items) items[items.findIndex((x) => x.id === i.id)] = i;
    else if (e.ev === 'items.delta') {
      const i = items.find((x) => x.id === e.itemId);
      i.text += e.text;
    }
  }
  return items;
}

for (const family of ['codex', 'claude', 'acp'] as const) {
  test(`${family}: a streamed reply and a tool call become the same items`, () => {
    const { feed, events, timers } = make();
    for (const raw of FIXTURES[family]) assert.deepEqual(feed.push('c', family, raw), { supported: true });
    timers.tick();
    assert.ok(
      events.every((event, index) => event.feedSeq === index + 1),
      'every family uses the same ordered feed cursor',
    );
    const view = followerView(events).filter((i) => i.type !== 'userMessage');
    assert.deepEqual(
      view.map((i) => i.type),
      ['agentMessage', 'commandExecution'],
    );
    assert.equal(view[0].text, 'Hello');
    assert.deepEqual(
      Object.keys(view[0]).sort(),
      [...Object.keys(msg('m', '')), 'rowId', ...(family === 'claude' ? ['sourceId'] : [])].sort(),
    );
    assert.deepEqual(view[1].status, 'completed');
    assert.equal(view[1].aggregatedOutput, 'a.txt');
    assert.deepEqual(Object.keys(view[1]).sort(), [...Object.keys(cmd('x', 'completed', '')), 'rowId'].sort());
    // the tool call was appended running, then replaced when it finished
    const tool = events.filter((e) => e.items?.[0]?.type === 'commandExecution').map((e) => [e.ev, e.items[0].status]);
    assert.deepEqual(tool, [
      ['items.append', 'inProgress'],
      ['items.replace', 'completed'],
    ]);
    // text only ever came as deltas, never as a second copy of the whole message
    assert.ok(events.some((e) => e.ev === 'items.delta' && e.field === 'text'));
    assert.deepEqual(
      feed.snapshotItems('c', 10).filter((i: any) => i.type !== 'userMessage'),
      view,
    );
    assert.deepEqual(
      events.filter((e) => e.ev === 'turn.state').map((e) => e.status),
      ['inProgress', 'completed'],
    );
    const next =
      family === 'codex'
        ? [
            { method: 'turn/started', params: { turn: { id: 'next', status: 'inProgress' } } },
            { method: 'item/started', params: { turnId: 'next', item: msg('next-reply', 'Next turn') } },
          ]
        : family === 'claude'
          ? [
              { kind: 'turnStarting', turnId: 'next', clientId: 'next-input', text: 'Continue' },
              stream({ type: 'message_start', message: { id: 'next-message' } }),
              stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
              stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Next turn' } }),
            ]
          : [
              { kind: 'turnStart', turnId: 'next', user: { id: 'next-input', content: [] } },
              {
                kind: 'update',
                turnId: 'next',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Next turn' } },
              },
            ];
    for (const raw of next) feed.push('c', family, raw);
    const snapshot = feed.snapshot('c');
    assert.equal(snapshot.liveTurn.id, 'next');
    assert.deepEqual(
      snapshot.liveItems.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text),
      ['Next turn'],
    );
    assert.equal(
      snapshot.liveItems.some((i: any) => i.type === 'commandExecution'),
      false,
      'a prior turn is not live output',
    );
  });
}

test('the three families agree on item kinds and fields apart from Claude native block identity', () => {
  const shapes = ['codex', 'claude', 'acp'].map((family) => {
    const { feed, timers } = make();
    for (const raw of FIXTURES[family]) feed.push('c', family as any, raw);
    timers.tick();
    return feed
      .snapshotItems('c', 10)
      .filter((i: any) => i.type !== 'userMessage')
      .map((i: any) => [
        i.type,
        Object.keys(i)
          .filter((key) => key !== 'sourceId')
          .sort(),
      ]);
  });
  assert.deepEqual(shapes[1], shapes[0]);
  assert.deepEqual(shapes[2], shapes[0]);
});

test('deltas wait for the 10 Hz tick, joined per item', () => {
  const { feed, events, timers } = make();
  const delta = (d: string, itemId = 'm') => ({ method: 'item/agentMessage/delta', params: { itemId, delta: d } });
  feed.push('c', 'codex', { method: 'item/started', params: { item: msg('m', '') } });
  for (const d of ['a', 'b', 'c', 'd']) feed.push('c', 'codex', delta(d));
  // the first goes at once (leading edge), the rest wait for the tick as one
  assert.deepEqual(
    events.filter((e) => e.ev === 'items.delta').map((e) => e.text),
    ['a'],
  );
  assert.equal(timers.waiting[0].ms, TICK_MS);
  timers.tick();
  assert.deepEqual(
    events.filter((e) => e.ev === 'items.delta').map((e) => e.text),
    ['a', 'bcd'],
  );
  // a snapshot holds exactly what was delivered
  feed.push('c', 'codex', delta('e'));
  feed.push('c', 'codex', delta('f'));
  assert.equal(feed.snapshotItems('c', 5)[0].text, 'abcdef');
});

test('reasoning summaries stream by index; other deltas and malformed ones are ignored', () => {
  const { feed, events, timers } = make();
  const summary = (d: any, i = 0) => ({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', summaryIndex: i, delta: d } });
  feed.push('c', 'codex', { method: 'item/started', params: { item: { type: 'reasoning', id: 'r', summary: ['x'], content: [] } } });
  feed.push('c', 'codex', summary('y'));
  feed.push('c', 'codex', summary('z', 1));
  feed.push('c', 'codex', { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r' } });
  feed.push('c', 'codex', { method: 'item/commandExecution/outputDelta', params: { itemId: 'r', delta: 'o' } });
  feed.push('c', 'codex', { method: 'item/agentMessage/delta', params: { delta: 'orphan' } });
  timers.tick();
  assert.deepEqual(feed.snapshotItems('c', 3)[0].summary, ['xy', 'z']);
  assert.equal(events.filter((e) => e.ev === 'items.delta').length, 2);
});

test('a reasoning item without summary parts takes a delta without an index', () => {
  const { feed } = make();
  feed.push('c', 'codex', { method: 'item/started', params: { item: { type: 'reasoning', id: 'r', content: [] } } });
  feed.push('c', 'codex', { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta: 'why' } });
  assert.deepEqual(feed.snapshotItems('c', 1)[0].summary, ['why']);
});

test('a delta for an unknown item or a chat without items changes no snapshot', () => {
  const { feed, timers } = make();
  feed.push('c', 'codex', { method: 'item/agentMessage/delta', params: { itemId: 'gone', delta: 'x' } });
  timers.tick();
  assert.deepEqual(feed.snapshotItems('c', 5), []);
  assert.deepEqual(feed.snapshotItems('other', 5), []);
});

test('an agent message without text yet takes its first delta', () => {
  const { feed } = make();
  feed.push('c', 'codex', { method: 'item/started', params: { item: { type: 'agentMessage', id: 'm' } } });
  feed.push('c', 'codex', { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'hi' } });
  assert.equal(feed.snapshotItems('c', 1)[0].text, 'hi');
});

test('item updates: unchanged ones are dropped, changed ones replace, ones without an id are skipped', () => {
  const { feed, events } = make();
  const item = (status: string) => ({ method: 'item/updated', params: { item: cmd('x', status, null) } });
  feed.push('c', 'codex', item('inProgress'));
  feed.push('c', 'codex', item('inProgress'));
  feed.push('c', 'codex', item('failed'));
  feed.push('c', 'codex', { method: 'item/updated', params: {} });
  feed.push('c', 'codex', { method: 'item/updated', params: { item: { type: 'x' } } });
  assert.deepEqual(
    events.map((e) => e.ev),
    ['items.append', 'items.replace'],
  );
});

test('the ring keeps the newest items, and a snapshot returns at most n', () => {
  const { feed, events } = make({ batcher: { ring: 3, timers: manualTimers() } });
  for (let i = 0; i < 5; i++) feed.push('c', 'codex', { method: 'item/completed', params: { item: msg(`m${i}`, `${i}`) } });
  assert.deepEqual(
    feed.snapshotItems('c', 10).map((i: any) => i.id),
    ['m2', 'm3', 'm4'],
  );
  assert.deepEqual(
    feed.snapshotItems('c', 2).map((i: any) => i.id),
    ['m3', 'm4'],
  );
  assert.deepEqual(feed.snapshotItems('c', 0), []);
  assert.equal(events.length, 5);
  const big = make();
  for (let i = 0; i < RING + 5; i++) big.feed.push('c', 'codex', { method: 'item/completed', params: { item: msg(`m${i}`, '') } });
  assert.equal(big.feed.snapshotItems('c').length, RING);
});

test('forget drops a chat, its pending text and its translators', () => {
  const { feed, events, timers } = make();
  feed.push('c', 'claude', { kind: 'turnStarting', turnId: 't', clientId: 'q', text: 'hi' });
  feed.push('c', 'codex', { method: 'item/started', params: { item: msg('m', '') } });
  feed.push('c', 'codex', { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'a' } });
  feed.push('c', 'codex', { method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'b' } });
  feed.forget('c');
  const before = events.length;
  timers.tick();
  assert.equal(events.length, before);
  assert.deepEqual(feed.snapshotItems('c', 5), []);
  // a new turn after forget starts a translator from scratch
  feed.push('c', 'claude', { kind: 'turnStarting', turnId: 't', clientId: 'q', text: 'again' });
  assert.equal(events.filter((e) => e.ev === 'turn.state').length, 2);
  feed.forget('never-seen');
});

test('a throwing translator is isolated and noted; the next event still works', () => {
  clearIgnored();
  const translators = {
    claude: {
      create: () => ({
        feed: () => {
          throw new Error('boom');
        },
      }),
    },
    codex: { create: () => ({ feed: (raw: any, emit: any) => emit('item/completed', { item: msg(raw.id, '') }) }) },
  };
  const { feed, events } = make({ translators });
  assert.deepEqual(feed.push('a', 'claude', { kind: 'message' }), { supported: true });
  assert.match(
    recentIgnored()
      .map((e: any) => `${e.context} ${e.message}`)
      .join('\n'),
    /translate a claude event.*boom/s,
  );
  feed.push('a', 'codex', { id: 'ok' });
  assert.equal(events.length, 1);
});

test('a throwing listener is noted and does not stop the feed', () => {
  clearIgnored();
  let n = 0;
  const feed = createItemFeed({
    emit: () => {
      n++;
      throw new Error('gone');
    },
    batcher: { timers: manualTimers() },
  });
  feed.push('c', 'codex', { method: 'item/completed', params: { item: msg('a', '') } });
  feed.push('c', 'codex', { method: 'item/completed', params: { item: msg('b', '') } });
  assert.equal(n, 2);
  assert.equal(feed.snapshotItems('c', 5).length, 2);
  assert.match(
    recentIgnored()
      .map((e: any) => e.context)
      .join('\n'),
    /remote item event/,
  );
});

test('unsupported events and families are reported, quiet kinds are accepted', () => {
  const { feed, events } = make();
  assert.deepEqual(feed.push('c', 'nope' as any, {}), { supported: false });
  assert.deepEqual(feed.push('c', 'codex', { id: 4 }), { supported: false });
  assert.deepEqual(feed.push('c', 'codex', null), { supported: false });
  assert.deepEqual(feed.push('c', 'claude', { kind: 'steerFailed' }), { supported: true });
  assert.deepEqual(feed.push('c', 'claude', null), { supported: false });
  assert.deepEqual(feed.push('c', 'acp', { kind: 'unattended' }), { supported: false });
  assert.deepEqual(feed.push('c', 'claude', { kind: 'permission' }), { supported: true });
  assert.deepEqual(feed.push('c', 'acp', { kind: 'threadName' }), { supported: true });
  assert.deepEqual(feed.push('c', 'acp', { kind: 'turnStarting' }), { supported: true });
  assert.deepEqual(feed.push('c', 'codex', { method: 'thread/name/updated' }), { supported: true });
  assert.deepEqual(events, []);
});

test('Claude: a turn ends on failure, close and error; an interrupt marks the end', () => {
  const run = (end: any, expected: string) => {
    const { feed, events } = make();
    feed.push('c', 'claude', { kind: 'turnStarting', turnId: 't', clientId: 'q', text: 'hi' });
    feed.push('c', 'claude', { kind: 'interrupting' });
    feed.push('c', 'claude', end);
    // a second end finds no turn
    feed.push('c', 'claude', end);
    assert.deepEqual(
      events.filter((e) => e.ev === 'turn.state').map((e) => e.status),
      ['inProgress', expected],
    );
  };
  run({ kind: 'turnFailed', error: 'bad' }, 'failed');
  run({ kind: 'closed' }, 'interrupted');
  run({ kind: 'error', error: 'bad' }, 'interrupted');
  const { feed, events } = make();
  feed.push('c', 'claude', { kind: 'turnStarting', turnId: 't', clientId: 'q', text: undefined });
  feed.push('c', 'claude', { kind: 'closed' });
  assert.deepEqual(
    events.filter((e) => e.ev === 'turn.state').map((e) => e.status),
    ['inProgress', 'failed'],
  );
  // a message without words has none to show (as the window path's userInput)
  assert.deepEqual(events[1].items[0].content, []);
});

test('ACP: a close cancels the running turn, once', () => {
  const { feed, events } = make();
  feed.push('c', 'acp', { kind: 'turnStart', turnId: 't', user: null });
  feed.push('c', 'acp', { kind: 'closed' });
  feed.push('c', 'acp', { kind: 'closed' });
  assert.deepEqual(
    events.filter((e) => e.ev === 'turn.state').map((e) => e.status),
    ['inProgress', 'interrupted'],
  );
});

test('a turn event without a turn id or status is passed as null', () => {
  const { feed, events } = make();
  feed.push('c', 'codex', { method: 'turn/started', params: {} });
  assert.deepEqual(events, [{ ev: 'turn.state', chatId: 'c', turnId: null, status: null, started: true, live: false, feedSeq: 1 }]);
});

test('Claude agent transcripts are not items of the chat', () => {
  const { feed, events } = make();
  feed.push('c', 'claude', { kind: 'turnStarting', turnId: 't', clientId: 'q', text: 'hi' });
  const before = events.length;
  feed.push('c', 'claude', claudeMsg({ type: 'system', subtype: 'task_started', task_id: 'z', description: 'd', tool_use_id: 'nope' }));
  assert.ok(events.length >= before);
  assert.ok(events.every((e) => !(e.items ?? []).some((i: any) => i.agentKey)));
});

test('the real timers drive the tick when none are injected', async () => {
  const events: any[] = [];
  const feed = createItemFeed({ emit: (e: any) => events.push(e) });
  const delta = (d: string) => ({ method: 'item/agentMessage/delta', params: { itemId: 'm', delta: d } });
  feed.push('c', 'codex', { method: 'item/started', params: { item: msg('m', '') } });
  for (const d of ['a', 'b', 'c']) feed.push('c', 'codex', delta(d));
  await new Promise((r) => setTimeout(r, TICK_MS * 3));
  assert.deepEqual(
    events.filter((e) => e.ev === 'items.delta').map((e) => e.text),
    ['a', 'bc'],
  );
  feed.forget('c');
  await new Promise((r) => setTimeout(r, TICK_MS * 2));
});
