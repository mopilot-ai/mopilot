// Recorded streams of every family through the batcher in main (electron/harness/coreBatcher.cjs): the final text
// windows build is byte-identical batched or not, with fewer sends.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ClaudeTranslator } from './support/claude-translate.ts';
import { AcpTranslator } from '../electron/harness/items/acpTranslator.cjs';

const require = createRequire(import.meta.url);
const { CoreBatcher, WATCHED_MS } = require('../electron/harness/coreBatcher.cjs');
const { familyChats } = require('../electron/harness/coreBatcher.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

let sent: [string, any][] = [];
const make = () => {
  sent = [];
  const b = new CoreBatcher({ send: (family: string, event: any) => (sent.push([family, event]), true) });
  for (const [family, c] of Object.entries(familyChats({ chatOf: (key: string) => key }))) b.register(family, c);
  return b;
};
const T = 'turn-1';
const codex = (chat: string, itemId: string, delta: string, method = 'item/agentMessage/delta', extra: any = {}) => ({
  kind: 'notification',
  chatId: chat,
  method,
  params: { threadId: chat, turnId: T, itemId, delta, ...extra },
});
const claude = (key: string, index: number, text: string, type = 'text_delta') => ({
  kind: 'message',
  key,
  msg: {
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: type === 'thinking_delta' ? { type, thinking: text } : { type, text } },
  },
});
const acp = (key: string, text: string, sessionUpdate = 'agent_message_chunk') => ({
  kind: 'update',
  key,
  turnId: T,
  update: { sessionUpdate, content: { type: 'text', text } },
});

/** Split text into irregular deltas, some splitting a surrogate pair or a combining sequence. */
function chunks(text: string, seed: number) {
  const out: string[] = [];
  let i = 0;
  let s = seed;
  while (i < text.length) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const n = 1 + (s % 7);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}
const REPLY = 'Hello 👋🏽 wörld — é ünïcode, `code` and **markdown**\n\n- one\n- two 🧑‍💻 done.';
const THOUGHT = 'Let me think… 思考中 then answer.';

/** What windows end up showing: each item's text, in item order, from the notifications a renderer translates to. */
function finalItems(notes: [string, any][]) {
  const items = new Map<string, string>();
  for (const [method, p] of notes) {
    if (method === 'item/started') items.set(p.item.id, p.item.text ?? p.item.summary?.join('') ?? '');
    if (method.endsWith('Delta') || method.endsWith('/delta')) items.set(p.itemId, (items.get(p.itemId) ?? '') + p.delta);
  }
  return [...items];
}
/** Deliver `events` unbatched and through the batcher (with a keyless event mid-stream and ticks at random). */
function bothWays(family: string, events: any[], translate: (events: any[]) => [string, any][]) {
  const b = make();
  for (const [i, e] of events.entries()) {
    b.push(family, e);
    if (i % 5 === 4) mock.timers.tick(WATCHED_MS);
  }
  b.flushAll();
  const batched = sent.filter(([f]) => f === family).map(([, e]) => e);
  assert.ok(batched.length < events.length, `${family}: fewer sends (${batched.length} < ${events.length})`);
  const want = finalItems(translate(events));
  assert.deepEqual(finalItems(translate(batched)), want);
  return want;
}

test('recorded Claude stream: the final text is byte-identical batched or not', () => {
  const message = (event: any) => ({ kind: 'message', key: 's', msg: { type: 'stream_event', event } });
  const events = [
    message({ type: 'message_start', message: { id: 'msg1' } }),
    message({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
    ...chunks(THOUGHT, 3).map((t) => claude('s', 0, t, 'thinking_delta')),
    message({ type: 'content_block_stop', index: 0 }),
    message({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
    ...chunks(REPLY, 5).map((t) => claude('s', 1, t)),
    message({ type: 'content_block_stop', index: 1 }),
  ];
  const translate = (list: any[]) => {
    const out: [string, any][] = [];
    const tr = new ClaudeTranslator('s', '/', (method: string, p: any) => out.push([method, p]));
    (tr as any).nextAutoId = 'T';
    for (const e of list) tr.onMessage(e.msg);
    return out;
  };
  assert.deepEqual(bothWays('claude', events, translate), [
    ['msg1:0', THOUGHT],
    ['msg1:1', REPLY],
  ]);
});

test('recorded ACP stream: the final text is byte-identical batched or not', () => {
  const events = [
    ...chunks(THOUGHT, 7).map((t) => acp('k', t, 'agent_thought_chunk')),
    ...chunks(REPLY.slice(0, 30), 11).map((t) => acp('k', t)),
    { kind: 'update', key: 'k', turnId: T, update: { sessionUpdate: 'tool_call', toolCallId: 'call', title: 'Read', status: 'completed' } },
    ...chunks(REPLY.slice(30), 13).map((t) => acp('k', t)),
  ];
  const translate = (list: any[]) => {
    const out: [string, any][] = [];
    const tr = new AcpTranslator('k', '/', (method: string, p: any) => out.push([method, p]));
    for (const e of list) tr.onUpdate(e.update, e.turnId);
    return out;
  };
  const items = bothWays('acp', events, translate);
  assert.deepEqual(
    items.filter(([id]) => !id.startsWith('call')),
    [
      [`${T}:r0`, THOUGHT],
      [`${T}:m1`, REPLY.slice(0, 30)],
      [`${T}:m2`, REPLY.slice(30)],
    ],
  );
});

test('recorded Codex stream: the final text is byte-identical batched or not', () => {
  const events = [
    {
      kind: 'notification',
      chatId: 'c',
      method: 'item/started',
      params: { threadId: 'c', turnId: T, item: { id: 'r', type: 'reasoning', summary: [] } },
    },
    ...chunks(THOUGHT, 17).map((t) => codex('c', 'r', t, 'item/reasoning/summaryTextDelta', { summaryIndex: 0 })),
    {
      kind: 'notification',
      chatId: 'c',
      method: 'item/started',
      params: { threadId: 'c', turnId: T, item: { id: 'm', type: 'agentMessage', text: '' } },
    },
    ...chunks(REPLY, 19).map((t) => codex('c', 'm', t)),
  ];
  const translate = (list: any[]) => list.map((e) => [e.method, e.params] as [string, any]);
  assert.deepEqual(bothWays('codex', events, translate), [
    ['r', THOUGHT],
    ['m', REPLY],
  ]);
});
