// The stream's second vocabulary (shared/host/stream2.mjs): a sub-agent's words and a command's live output from the Host to the app's mirror, and what an end without the `stream2` feature is not told. A: ids and keys; W: replay after a reconnect shows nothing twice; B: the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { createItemMapper } from '../host/src/codexItems.mjs';
import { FEATURES, helloParams } from '../shared/host/schema.mjs';
import { STREAM2_FEATURE, needsStream2, withoutStream2 } from '../shared/host/stream2.mjs';
import { CHAT, tick, world } from './support/host/remoteChatsKit.ts';

const quiet = { report: () => undefined };
const META = { claudeCode: { parentToolUseId: 'tu-agent' } };

function setup(features: string[] = [...FEATURES]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-stream2-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = {
    host,
    send: async () => ({ turnId: 't' }),
    prepare: async () => undefined,
    permit: () => true,
    familyOf: () => 'claude',
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }) });
  const out: any[] = [];
  const conn = protocol.connection((m: object) => out.push(m));
  const ready = conn.call('host.hello', { ...helloParams(), features });
  let n = 0;
  const call = async (method: string, chatId: string, p: any = {}) => (
    await ready, conn.call(method, { chatId, epoch: 1, key: `key-s2-${++n}-00`, ...p })
  );
  const frames = (chatId: string) => out.filter((m) => m.chatId === chatId && m.frame).map((m) => m.frame);
  const update = (turnId: string, u: object) => host.emit('event', { kind: 'update', turnId, update: u });
  const begin = (chatId: string, turnId: string) => host.emit('event', { kind: 'turnStart', key: chatId, turnId });
  return { host, call, frames, update, begin, conn, ready };
}
const chunk = (text: string, extra: object = {}) => ({
  sessionUpdate: 'agent_message_chunk',
  messageId: 'm',
  content: { type: 'text', text },
  ...extra,
});

test('A: a sub-agent’s words are their own message with their call kept, and are not the turn’s reply', async () => {
  const s = setup();
  await s.call('chat.subscribe', 'claude:c1');
  s.begin('claude:c1', 't1');
  s.update('t1', chunk('chat '));
  s.update('t1', chunk('sub ', { messageId: 'sub1', _meta: META }));
  s.update('t1', chunk('words', { messageId: 'sub1', _meta: META }));
  s.update('t1', chunk('reply'));
  s.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  const f = s.frames('claude:c1');
  const deltas = f.filter((x) => x.t === 'delta');
  assert.deepEqual(
    deltas.map((d) => [d.delta.text, d.delta._meta ?? null]),
    [
      ['chat ', null],
      ['sub ', META],
      ['words', META],
      ['reply', null],
    ],
  );
  const events = f.filter((x) => x.t === 'durable' && x.item.event?.update).map((x) => x.item.event.update);
  assert.deepEqual(
    events.map((u) => [u.content.text, u._meta ?? null]),
    [
      ['chat ', null],
      ['sub words', META],
      ['reply', null],
    ],
  );
  assert.equal(f.find((x) => x.t === 'durable' && x.item.t === 'assistant').item.text, 'chat reply');
});

test('B: an end without `stream2` is not told a sub-agent’s words or a command’s live output, in hello, replay, deltas and frames; the rest is as it was', async () => {
  const s = setup(FEATURES.filter((f: string) => f !== STREAM2_FEATURE));
  await s.call('chat.subscribe', 'claude:c1');
  s.begin('claude:c1', 't1');
  s.update('t1', chunk('sub', { messageId: 'sub1', _meta: META }));
  s.update('t1', { sessionUpdate: 'tool_output_delta', toolCallId: 'c1', content: { type: 'text', text: 'out' } });
  s.update('t1', chunk('mine'));
  s.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  const f = s.frames('claude:c1');
  assert.deepEqual(
    f.filter((x) => x.t === 'delta').map((d) => d.delta.text),
    ['mine'],
  );
  const kinds = f.filter((x) => x.t === 'durable').map((x) => x.item.event?.kind ?? x.item.t);
  assert.ok(!kinds.includes('state'));
  assert.deepEqual(
    f.filter((x) => x.t === 'durable' && x.item.t === 'event' && x.item.event.update).map((x) => x.item.event.update.content.text),
    ['mine'],
  );
  // an end that subscribes later is given a snapshot without them, too
  s.host.emit('event', { kind: 'turnStart', key: 'claude:c2', turnId: 't2' });
  const late = setup(FEATURES.filter((x: string) => x !== STREAM2_FEATURE));
  await late.call('chat.subscribe', 'claude:c3');
  late.begin('claude:c3', 't3');
  late.update('t3', chunk('sub', { _meta: META }));
  late.update('t3', chunk('mine2'));
  late.update('t3', { sessionUpdate: 'tool_output_delta', toolCallId: 'c', content: { type: 'text', text: 'o' } });
  await late.conn.call('chat.subscribe', { chatId: 'claude:c3', epoch: 1, key: 'key-s2-late-001' });
  const hello = late
    .frames('claude:c3')
    .filter((x) => x.t === 'hello')
    .at(-1);
  assert.deepEqual(
    hello.inFlightEphemeral.flatMap((r: any) => r.deltas.map((d: any) => d.text)),
    ['mine2'],
  );
  // with the feature all of it is sent
  const all = setup();
  await all.call('chat.subscribe', 'claude:c4');
  all.begin('claude:c4', 't4');
  all.update('t4', chunk('sub', { _meta: META }));
  assert.equal(all.frames('claude:c4').filter((x) => x.t === 'delta').length, 1);
});

test('A: a command’s live output takes no revision; its call ends it with the whole output, and a turn that ends leaves none behind', async () => {
  const s = setup();
  await s.call('chat.subscribe', 'chat-codex');
  s.host.emit('event', { kind: 'turnStart', key: 'chat-codex', turnId: 't1' });
  const live = (id: string, t: string) =>
    s.update('t1', { sessionUpdate: 'tool_output_delta', toolCallId: id, content: { type: 'text', text: t } });
  s.update('t1', { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'ls', status: 'in_progress' });
  const revs = () => s.frames('chat-codex').filter((x) => x.t === 'durable').length;
  const before = revs();
  live('c1', 'a');
  live('c1', 'b');
  live('c2', 'z');
  live('c3', 'zz');
  s.update('t1', { sessionUpdate: 'tool_output_delta', toolCallId: 5, content: { type: 'text', text: 'bad' } });
  s.update('t1', { sessionUpdate: 'tool_output_delta', toolCallId: 'c9', content: {} });
  assert.equal(revs(), before);
  const deltas = s.frames('chat-codex').filter((x) => x.t === 'delta');
  assert.deepEqual(
    deltas.map((d) => [d.key, d.delta.text]),
    [
      ['t1:out:c1', 'a'],
      ['t1:out:c1', 'b'],
      ['t1:out:c2', 'z'],
      ['t1:out:c3', 'zz'],
    ],
  );
  s.update('t1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { output: 'ab' } });
  s.host.emit('event', { kind: 'turnEnd', turnId: 't1', stopReason: 'cancelled' });
  const durable = s.frames('chat-codex').filter((x) => x.t === 'durable' && x.promotes);
  assert.deepEqual(
    durable.map((x) => x.promotes),
    ['t1:out:c1'],
  );
  assert.deepEqual(
    s
      .frames('chat-codex')
      .filter((x) => x.t === 'retract')
      .map((x) => x.key)
      .sort(),
    ['t1:out:c2', 't1:out:c3'],
  );
  // a client that subscribes now is handed no live output of a finished turn
  await s.conn.call('chat.subscribe', { chatId: 'chat-codex', epoch: 1, key: 'key-s2-after-001' });
  const hello = s
    .frames('chat-codex')
    .filter((x) => x.t === 'hello')
    .at(-1);
  assert.deepEqual(hello.inFlightEphemeral, []);
});

test('A: Codex’s output delta is a live update on its command, capped, and forgotten when the command or turn ends', () => {
  const m = createItemMapper();
  const T = 't1';
  const out = (itemId: any, delta: any) => m.map('item/commandExecution/outputDelta', { turnId: T, itemId, delta });
  assert.deepEqual(out('c1', 'total 0\n'), [
    { turnId: T, update: { sessionUpdate: 'tool_output_delta', toolCallId: 'c1', content: { type: 'text', text: 'total 0\n' } } },
  ]);
  assert.deepEqual(out('c1', ''), []);
  assert.deepEqual(out('c1', 5), []);
  assert.deepEqual(out(7, 'x'), []);
  const big = (out('c2', 'x'.repeat(70_000))[0].update as any).content.text;
  assert.equal(big.length, 64_000);
  assert.deepEqual(out('c2', 'more'), []);
  // a command that ends frees its budget; so does a turn
  m.map('item/started', { turnId: T, item: { id: 'c2', type: 'commandExecution', command: 'x', status: 'inProgress' } });
  m.map('item/completed', { turnId: T, item: { id: 'c2', type: 'commandExecution', command: 'x', status: 'completed' } });
  assert.equal(out('c2', 'again').length, 1);
  m.forget(T);
  m.reset();
});

test('B: needsStream2 and withoutStream2 take only what an older end would misread', () => {
  assert.equal(needsStream2(null), false);
  assert.equal(needsStream2({ kind: 'update', update: null }), false);
  assert.equal(needsStream2({ kind: 'update', update: { sessionUpdate: 'plan' } }), false);
  assert.equal(needsStream2({ kind: 'update', update: chunk('x') }), false);
  assert.equal(needsStream2({ kind: 'update', update: chunk('x', { _meta: META }) }), true);
  assert.equal(needsStream2({ sessionUpdate: 'agent_thought_chunk', _meta: META }), true);
  assert.equal(needsStream2({ kind: 'state' }), false);
  assert.equal(needsStream2({ kind: 'update', update: { sessionUpdate: 'tool_output_delta' } }), true);
  const item = (event: object) => ({ t: 'event', family: 'claude', event });
  assert.equal(withoutStream2({ t: 'durable', item: item({ kind: 'update', update: chunk('x', { _meta: META }) }) }), null);
  assert.deepEqual(withoutStream2({ t: 'durable', item: { t: 'assistant' } }), { t: 'durable', item: { t: 'assistant' } });
  assert.equal(withoutStream2({ t: 'delta', delta: { sessionUpdate: 'tool_output_delta' } }), null);
  assert.deepEqual(withoutStream2({ t: 'retract', key: 'k' }), { t: 'retract', key: 'k' });
  assert.equal(withoutStream2(null), null);
  const hello = withoutStream2({ t: 'hello', snapshot: null, inFlightEphemeral: [] });
  assert.equal(hello.snapshot, null);
  // a run of unfinished text that held only what an older end cannot read is left out; an empty one is kept as it was
  const runs = withoutStream2({
    t: 'hello',
    snapshot: null,
    inFlightEphemeral: [
      { key: 'a', deltas: [{ sessionUpdate: 'tool_output_delta' }] },
      { key: 'b', deltas: [{ sessionUpdate: 'agent_message_chunk', text: 'x' }] },
      { key: 'c', deltas: [] },
    ],
  });
  assert.deepEqual(
    runs.inFlightEphemeral.map((r: any) => r.key),
    ['b', 'c'],
  );
  const snap = withoutStream2({
    t: 'hello',
    snapshot: { rev: 2, items: [item({ kind: 'update', update: chunk('x', { _meta: META }) }), item({ kind: 'turnEnd' })] },
    inFlightEphemeral: [],
  });
  assert.equal(snap.snapshot.items.length, 1);
});

test('A: the mirror draws a command’s live output as its call’s whole output so far, a sub-agent’s words with their call, and the finished call replaces the live view', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const key = 't1:out:c1';
  const head = { turnId: 't1', sessionUpdate: 'tool_output_delta', toolCallId: 'c1' };
  w.host.fire.delta(CHAT, key, { ...head, text: 'a' });
  w.host.fire.delta(CHAT, key, { ...head, text: 'b' });
  w.host.fire.delta(CHAT, 't1:agent_message_chunk:s:tu-agent', {
    turnId: 't1',
    sessionUpdate: 'agent_message_chunk',
    messageId: 's',
    _meta: META,
    text: 'sub',
  });
  await tick();
  const updates = w.emitted.filter((e) => e.kind === 'update').map((e) => e.update);
  assert.deepEqual(
    updates.map((u) => u.rawOutput?.output ?? u._meta),
    ['a', 'ab', META],
  );
  assert.deepEqual(updates[1].content, [{ type: 'content', content: { type: 'text', text: 'ab' } }]);
  assert.equal(updates[1].status, 'in_progress');
  // a reconnect hands back what is still in flight: nothing is drawn twice, and the longer view goes on from what is drawn
  w.host.fire.inflight(CHAT, [
    {
      key,
      deltas: [
        { ...head, text: 'a' },
        { ...head, text: 'b' },
        { ...head, text: 'c' },
      ],
    },
  ]);
  await tick();
  const after = w.emitted.filter((e) => e.kind === 'update').map((e) => e.update.rawOutput?.output ?? null);
  assert.deepEqual(after.slice(3), ['abc']);
  // the call ends: its whole output replaces the live view, and the live key is forgotten
  const done = {
    t: 'event',
    family: 'codex',
    event: {
      kind: 'update',
      turnId: 't1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { output: 'abcdef' } },
    },
  };
  w.host.fire.patch(CHAT, 1, done, key);
  await tick();
  assert.equal((w.emitted.at(-1) as any).update.rawOutput.output, 'abcdef');
});
