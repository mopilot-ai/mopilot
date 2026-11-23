// Events a contract lets wait (electron/harness/coreBatcher.cjs `waits`, ACP's tool and usage updates): they queue behind
// the chat's pending deltas in order, never join, go out in the tick's one flush, and keep the 250 ms lane for windows without the chat.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CoreBatcher, WATCHED_MS, BACKGROUND_MS } = require('../electron/harness/coreBatcher.cjs');
const { familyChats } = require('../electron/harness/coreBatcher.cjs');

mock.timers.enable({ apis: ['setTimeout'] });

let sent: { event: any; target: any; scope: any }[] = [];
let flushes: number[] = [];
const made: any[] = [];
const make = (o: any = {}) => {
  const b = new CoreBatcher({
    send: (_family: string, event: any, target: any, scope: any) => (sent.push({ event, target, scope }), true),
    batch: (fn: () => void) => {
      const before = sent.length;
      fn();
      if (sent.length > before) flushes.push(sent.length - before);
    },
    ...o,
  });
  for (const [family, c] of Object.entries(familyChats({ chatOf: (key: string) => key }))) b.register(family, c);
  made.push(b);
  return b;
};
beforeEach(() => {
  for (const b of made.splice(0)) b.cancel();
  sent = [];
  flushes = [];
});

const chunk = (key: string, text: string, kind = 'agent_message_chunk') => ({
  kind: 'update',
  key,
  turnId: 't',
  update: { sessionUpdate: kind, content: { type: 'text', text } },
});
const tool = (key: string, id: string, sessionUpdate = 'tool_call') => ({
  kind: 'update',
  key,
  turnId: 't',
  update: { sessionUpdate, toolCallId: id },
});
const what = () =>
  sent.map(({ event: e }) =>
    !e.update
      ? e.kind
      : e.update.content
        ? `${e.update.sessionUpdate}:${e.update.content.text}`
        : `${e.update.sessionUpdate}:${e.update.toolCallId}`,
  );

test('a tool update waits behind the chat’s deltas and goes out in the tick’s flush, in order', () => {
  const b = make();
  b.push('acp', chunk('c', 'a'));
  assert.deepEqual(what(), ['agent_message_chunk:a'], 'the leading edge');
  b.push('acp', chunk('c', 'b'));
  b.push('acp', tool('c', '1'));
  b.push('acp', chunk('c', 'c'));
  b.push('acp', chunk('c', 'd'));
  b.push('acp', tool('c', '1', 'tool_call_update'));
  assert.equal(sent.length, 1, 'nothing goes out before the tick');
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(what().slice(1), ['agent_message_chunk:b', 'tool_call:1', 'agent_message_chunk:cd', 'tool_call_update:1']);
  assert.deepEqual(flushes, [1, 4], 'one flush for the tick');
});

test('two tool updates in a row are never joined', () => {
  const b = make();
  b.push('acp', tool('c', '1'));
  b.push('acp', tool('c', '2'));
  b.push('acp', tool('c', '3'));
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(what(), ['tool_call:1', 'tool_call:2', 'tool_call:3']);
});

test('every chat’s waiting events go out together in one tick flush', () => {
  const b = make();
  b.push('acp', tool('x', '0'));
  b.push('acp', tool('x', '1'));
  b.push('acp', tool('y', '2'));
  flushes = [];
  mock.timers.tick(WATCHED_MS);
  assert.deepEqual(flushes, [2]);
  assert.equal(what().length, 3);
});

test('an event that ends the turn flushes what waits before it, so nothing falls behind', () => {
  const b = make();
  b.push('acp', chunk('c', 'a'));
  b.push('acp', chunk('c', 'b'));
  b.push('acp', tool('c', '1'));
  b.push('acp', { kind: 'turnEnd', key: 'c', turnId: 't' });
  assert.deepEqual(what().slice(0, 3), ['agent_message_chunk:a', 'agent_message_chunk:b', 'tool_call:1']);
  assert.equal(sent[3].event.kind, 'turnEnd');
  mock.timers.tick(WATCHED_MS * 3);
  assert.equal(sent.length, 4, 'the tick has nothing left to send twice');
});

test('flushing a chat sends its waiting events; the chat’s deletion drops none', () => {
  const b = make();
  b.push('acp', chunk('c', 'a'));
  b.push('acp', tool('c', '1'));
  b.flushNamed(['c']);
  assert.deepEqual(what(), ['agent_message_chunk:a', 'tool_call:1']);
});

test('a hidden window ticks at the slow rate; a window without the chat gets the events on the slow lane too', () => {
  const b = make({ watched: () => false, hasBackground: (chat: string) => chat === 'bg' });
  b.push('acp', chunk('bg', 'a'));
  b.push('acp', tool('bg', '1'));
  b.push('acp', tool('bg', '2'));
  sent = [];
  mock.timers.tick(WATCHED_MS);
  assert.equal(sent.length, 0, 'not a frame tick while no window is on screen');
  mock.timers.tick(BACKGROUND_MS);
  const mine = sent.filter((s) => s.scope.background === false).map((s) => s.event.update.toolCallId ?? s.event.update.content.text);
  const slow = sent.filter((s) => s.scope.background === true).map((s) => s.event.update.toolCallId ?? s.event.update.content.text);
  assert.deepEqual(mine, ['1', '2']);
  assert.deepEqual(slow, ['1', '2'], 'the same events, once per lane');
});

test('an event for one window and an event without a chat are not queued', () => {
  const b = make();
  b.push('acp', tool('c', '1'), 7);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, 7);
  b.push('acp', { kind: 'update', turnId: 't', update: { sessionUpdate: 'tool_call', toolCallId: '2' } });
  assert.equal(sent.length, 2, 'no chat: sent at once');
});

test('an update that throws as it is read is sent at once, after every chat’s pending deltas', () => {
  const b = make();
  b.push('acp', chunk('c', 'a'));
  b.push('acp', chunk('c', 'b'));
  b.push('acp', chunk('other', 'x'));
  let reads = 0;
  const odd = {
    kind: 'update',
    key: 'c',
    get update() {
      if (!reads++) throw new Error('bad');
      return null;
    },
  };
  b.push('acp', odd);
  assert.deepEqual(what(), ['agent_message_chunk:a', 'agent_message_chunk:b', 'agent_message_chunk:x', 'update']);
});

test('only the families that say so wait: Codex and Claude events outside the deltas still go out at once', () => {
  const b = make();
  b.push('codex', { kind: 'status', chatId: 'c' });
  assert.equal(sent.length, 1);
});

test('an update with no record (malformed) is sent at once', () => {
  const b = make();
  b.push('acp', { kind: 'update', key: 'c', turnId: 't', update: null });
  assert.equal(sent.length, 1);
});
