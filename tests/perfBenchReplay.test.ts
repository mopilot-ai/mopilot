// The streaming benchmark's pacing and protocol rewriting (scripts/perf-bench/replay.mjs, rewrite.mjs): replies cut and timed by a
// fake clock, the control folder, and each family's stream held in order behind the replayed text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHARS_PER_TOKEN,
  MARK,
  chunksOf,
  intervalMs,
  logEvent,
  makeReply,
  play,
  readSettings,
  waitGate,
} from '../scripts/perf-bench/replay.mjs';
import { PROTOCOLS, createRewriter, marked } from '../scripts/perf-bench/rewrite.mjs';
import { tick as settle } from './support/async-scenarios.ts';

/** A clock and timers that move only when told. */
function fakeTime() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout: ((fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    }) as any,
    clearTimeout: ((id: number) => void timers.delete(id)) as any,
    pending: () => timers.size,
    /** Moves the clock to each due timer in turn, letting promises settle between them. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        await new Promise((r) => setImmediate(r));
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

test('a synthetic reply has exactly the size asked for, with prose, a list and a code block', () => {
  const r = makeReply(4096);
  assert.equal(r.length, 4096);
  assert.equal(makeReply(4096), r, 'the same for the same size');
  assert.match(r, /\n- \w+/);
  assert.match(r, /```js\n/);
  assert.equal(makeReply(10).length, 10);
});

test('chunks never split a character, and the interval follows the token rate', () => {
  assert.deepEqual(chunksOf('abcdefg', 3), ['abc', 'def', 'g']);
  assert.deepEqual(chunksOf('a😀b', 2), ['a😀', 'b']);
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(intervalMs(40, 4), 25);
  assert.equal(intervalMs(120, 32), (32 / 480) * 1000);
});

test('settings come from replay.json, with defaults; anything else is pass-through', () => {
  assert.deepEqual(readSettings(undefined), { mode: 'pass' });
  assert.deepEqual(readSettings('/x', { read: () => '{' }), { mode: 'pass' });
  assert.deepEqual(readSettings('/x', { read: () => '{"mode":"pass"}' }), { mode: 'pass' });
  assert.deepEqual(readSettings('/x', { read: () => 'null' }), { mode: 'pass' });
  assert.deepEqual(readSettings('/x', { read: () => '{"mode":"replay"}' }), {
    mode: 'replay',
    bytes: 4096,
    rate: 40,
    chunk: 4,
    toolEveryMs: 0,
    gate: false,
  });
  const files: string[] = [];
  const s = readSettings('/ctl', {
    read: (f) => (
      files.push(f), JSON.stringify({ mode: 'replay', bytes: 10, rate: 120, chunk: 32, toolEveryMs: 200, gate: true, text: 'hi' })
    ),
  });
  assert.deepEqual(s, { mode: 'replay', bytes: 10, rate: 120, chunk: 32, toolEveryMs: 200, gate: true, text: 'hi' });
  assert.deepEqual(files, [path.join('/ctl', 'replay.json')]);
});

test('turn events go to events.jsonl in the control folder, and nowhere without one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-'));
  logEvent(undefined, { kind: 'start' });
  logEvent(dir, { kind: 'start', key: 'a' }, { now: () => 5 });
  logEvent(dir, { kind: 'end', key: 'a' });
  const lines = fs
    .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { at: 5, pid: process.pid, kind: 'start', key: 'a' });
  assert.equal(lines[1].kind, 'end');
});

test('the gate opens when the go file appears, and at once without a control folder', async () => {
  await waitGate(undefined);
  const time = fakeTime();
  let there = false;
  let open = false;
  void waitGate('/ctl', { exists: (f) => (assert.equal(f, path.join('/ctl', 'go')), there), setTimeout: time.setTimeout }).then(
    () => (open = true),
  );
  await time.advance(100);
  assert.equal(open, false);
  there = true;
  await time.advance(20);
  assert.equal(open, true);
});

test('a reply plays each delta at its time from the start, with tool calls between, after the gate', async () => {
  const time = fakeTime();
  let gate!: () => void;
  const out: [number, string][] = [];
  const run = play(
    { text: 'aaaabbbbcccc', rate: 10, chunk: 4, toolEveryMs: 150 },
    { onChunk: (c) => out.push([time.now(), c]), onTool: (n) => out.push([time.now(), `tool ${n}`]) },
    { ...time, gate: () => new Promise<void>((r) => (gate = r)) },
  );
  await time.advance(500);
  assert.deepEqual(out, [], 'held until the gate opens');
  gate();
  await time.advance(1000);
  await run.done;
  // 10 tokens/s × 4 chars = 40 chars/s: a 4-character delta every 100 ms
  assert.deepEqual(out, [
    [500, 'aaaa'],
    [600, 'bbbb'],
    [650, 'tool 1'],
    [700, 'cccc'],
  ]);
});

test('a reply plays without tool calls when none are asked for, and cancel stops it before the next delta', async () => {
  const time = fakeTime();
  const out: string[] = [];
  const run = play({ text: 'abcdef', rate: 1, chunk: 2 }, { onChunk: (c) => out.push(c) }, time);
  await time.advance(0);
  assert.deepEqual(out, ['ab']);
  run.cancel();
  await run.done;
  assert.deepEqual(out, ['ab']);
  assert.equal(time.pending(), 0);
  run.cancel();
  // the real timers when none are given
  const real: string[] = [];
  await play({ text: 'xy', rate: 1000, chunk: 1 }, { onChunk: (c) => real.push(c) }).done;
  assert.deepEqual(real, ['x', 'y']);
});

test('a cancel before the gate opens plays nothing', async () => {
  let gate!: () => void;
  const out: string[] = [];
  const run = play(
    { text: 'ab', rate: 1, chunk: 1 },
    { onChunk: (c) => out.push(c) },
    { gate: () => new Promise<void>((r) => (gate = r)) },
  );
  run.cancel();
  gate();
  await run.done;
  assert.deepEqual(out, []);
});

/** A rewriter over a manual player: each reply plays when the test says. */
function rig(protocol: keyof typeof PROTOCOLS, settings: any = { mode: 'replay', bytes: 6, rate: 1, chunk: 3, toolEveryMs: 0 }) {
  const out: any[] = [];
  const events: any[] = [];
  const runs: { s: any; on: any; finish: () => void; cancelled: boolean }[] = [];
  const rw = createRewriter({
    protocol: PROTOCOLS[protocol],
    settings: () => settings,
    out: (line) => out.push(line.startsWith('{') ? JSON.parse(line) : line),
    player: (s, on) => {
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      const run = { s, on, finish, cancelled: false };
      runs.push(run);
      return {
        done,
        cancel: () => {
          run.cancelled = true;
          finish();
        },
      };
    },
    reply: (bytes) => 'x'.repeat(bytes),
    log: (e) => events.push(e),
  });
  const agent = (msg: any) => rw.fromAgent(JSON.stringify(msg));
  const client = (msg: any) => rw.fromClient(JSON.stringify(msg));
  return { rw, out, events, runs, agent, client };
}

test('Codex: the reply item is replayed, the rest of its turn waits, and the completed item and turn carry the replayed text', async () => {
  const r = rig('codex');
  const p = { threadId: 'T', turnId: 'u1', itemId: 'i1' };
  r.client({ method: 'turn/start', params: { threadId: 'T', input: [{ type: 'text', text: '[bench] hi' }] } });
  r.agent({ id: 1, result: {} });
  r.agent({ method: 'item/agentMessage/delta', params: { ...p, delta: 'fake-co' } });
  assert.equal(r.runs.length, 1);
  assert.deepEqual(r.runs[0].s, { text: 'xxxxxx', rate: 1, chunk: 3, toolEveryMs: 0, gate: undefined });
  r.agent({ method: 'item/agentMessage/delta', params: { ...p, delta: 'dex: hi' } });
  r.agent({ method: 'item/completed', params: { threadId: 'T', item: { id: 'i1', type: 'agentMessage', text: 'fake-codex: hi' } } });
  r.agent({ id: 2, result: { ok: true } });
  r.agent({ method: 'thread/status/changed', params: { threadId: 'OTHER' } });
  r.runs[0].on.onChunk('xxx');
  r.runs[0].on.onTool(1);
  r.runs[0].on.onChunk('xxx');
  r.agent({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'u1', items: [{ id: 'u' }, { id: 'i1', text: 'old' }] } } });
  assert.deepEqual(
    r.out.map((m) => m.method ?? `#${m.id}`),
    ['#1', '#2', 'thread/status/changed', 'item/agentMessage/delta', 'item/agentMessage/delta'],
  );
  assert.deepEqual(r.out[3].params, { ...p, delta: 'xxx' });
  r.runs[0].finish();
  await settle();
  assert.deepEqual(
    r.out.slice(5).map((m) => m.method),
    ['item/completed', 'turn/completed'],
  );
  assert.equal(r.out[5].params.item.text, 'xxxxxx');
  assert.deepEqual(r.out[6].params.turn.items, [{ id: 'u' }, { id: 'i1', text: 'xxxxxx' }]);
  assert.deepEqual(r.events, [
    { kind: 'start', key: 'T' },
    { kind: 'end', key: 'T', chars: 6 },
  ]);
  // the turn ended: the next reply on the thread is replayed afresh
  r.client({ method: 'turn/start', params: { threadId: 'T', input: [{ type: 'text', text: '[bench] again' }] } });
  r.agent({ method: 'item/agentMessage/delta', params: { threadId: 'T', turnId: 'u2', itemId: 'i2', delta: 'y' } });
  assert.equal(r.runs.length, 2);
  r.runs[1].finish();
  await r.rw.idle();
});

test("Codex: after the replay, the turn's later messages pass rewritten until it completes; an interrupt ends the replay", async () => {
  const r = rig('codex');
  const p = { threadId: 'T', turnId: 'u1', itemId: 'i1' };
  r.client({ method: 'turn/start', params: { threadId: 'T', input: [{ type: 'text', text: '[bench] hi' }] } });
  r.agent({ method: 'item/agentMessage/delta', params: { ...p, delta: 'a' } });
  r.runs[0].on.onChunk('xxxxxx');
  r.client({ method: 'turn/interrupt', params: { threadId: 'T', turnId: 'u1' } });
  r.client({ method: 'turn/interrupt', params: {} });
  r.client({ id: 3, method: 'thread/list' });
  r.rw.fromClient('not json');
  r.rw.fromClient('7');
  assert.equal(r.runs[0].cancelled, true);
  await settle();
  // the fake's own delta, after the replay ended, is dropped; the item completes with the replayed text
  r.agent({ method: 'item/agentMessage/delta', params: { ...p, delta: 'b' } });
  r.agent({ method: 'item/completed', params: { threadId: 'T', item: { id: 'i1', text: 'a b' } } });
  r.agent({ method: 'item/completed', params: { threadId: 'T', item: { id: 'other', text: 'kept' } } });
  r.agent({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'u1' } } });
  r.agent({ method: 'turn/completed', params: { threadId: 'T', turn: { id: 'u1' } } });
  assert.deepEqual(
    r.out.map((m) => [m.method, m.params.item?.text ?? m.params.delta ?? null]),
    [
      ['item/agentMessage/delta', 'xxxxxx'],
      ['item/completed', 'xxxxxx'],
      ['item/completed', 'kept'],
      ['turn/completed', null],
      ['turn/completed', null],
    ],
  );
});

test('pass-through settings, non-JSON lines and other messages go out unchanged', () => {
  const r = rig('codex', { mode: 'pass' });
  r.rw.fromAgent('a log line');
  r.rw.fromAgent('42');
  r.client({ method: 'turn/start', params: { threadId: 'T', input: [{ type: 'text', text: '[bench] hi' }] } });
  r.agent({ method: 'item/agentMessage/delta', params: { threadId: 'T', turnId: 'u', itemId: 'i', delta: 'hi' } });
  r.agent({ method: 'item/agentMessage/delta', params: { threadId: 7 } });
  assert.deepEqual(r.out, ['a log line', '42', r.out[2], r.out[3]]);
  assert.equal(r.out[2].params.delta, 'hi');
  assert.equal(r.runs.length, 0);
});

test('Claude Code: the text block is replayed, the rest of the reply waits, and the message and result carry the replayed text', async () => {
  const r = rig('claude');
  const ev = (event: any) => ({ type: 'stream_event', event, session_id: 'S', uuid: 'u' });
  r.client({
    type: 'user',
    message: {
      content: [
        { type: 'text', text: '<sage-handoff>…' },
        { type: 'text', text: '[bench] go' },
      ],
    },
  });
  r.agent({ type: 'system', subtype: 'init', session_id: 'S' });
  r.agent(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  r.agent(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fake' } }));
  r.agent(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '-claude' } }));
  r.agent(ev({ type: 'content_block_stop', index: 0 }));
  r.agent({ type: 'control_request', request_id: 'c1', request: { subtype: 'can_use_tool' } });
  r.agent({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '…' },
        { type: 'text', text: 'fake-claude' },
        { type: 'text', text: 'second' },
      ],
    },
  });
  r.agent({ type: 'assistant', message: {} });
  r.agent({ type: 'result', subtype: 'success', result: 'fake-claude', session_id: 'S' });
  r.runs[0].on.onChunk('xxx');
  r.runs[0].on.onTool(1);
  assert.deepEqual(
    r.out.map((m) => m.event?.type ?? m.type),
    ['system', 'content_block_start', 'control_request', 'content_block_delta'],
  );
  assert.equal(r.out[3].event.delta.text, 'xxx');
  assert.equal(r.out[3].session_id, 'S');
  r.runs[0].on.onChunk('xxx');
  r.runs[0].finish();
  await r.rw.idle();
  const tail = r.out.slice(5);
  assert.deepEqual(
    tail.map((m) => m.event?.type ?? m.type),
    ['content_block_stop', 'assistant', 'assistant', 'result'],
  );
  assert.deepEqual(tail[1].message.content, [
    { type: 'thinking', thinking: '…' },
    { type: 'text', text: 'xxxxxx' },
    { type: 'text', text: 'second' },
  ]);
  assert.equal(tail[3].result, 'xxxxxx');
  r.agent({ type: 'result', result: 7 });
  assert.equal(r.out.at(-1).result, 7);
});

test('Claude Code: an interrupt ends every replay; keyless deltas are keyed by the empty session', async () => {
  const r = rig('claude');
  r.client({ type: 'user', message: { content: '[bench] go' } });
  r.agent({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'a' } } });
  r.agent({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{' } },
  });
  r.client({ type: 'control_request', request_id: 'i', request: { subtype: 'interrupt' } });
  r.client({ type: 'control_request', request_id: 'j', request: { subtype: 'set_model' } });
  r.client({ type: 'user', message: {} });
  assert.equal(r.runs[0].cancelled, true);
  await r.rw.idle();
  assert.deepEqual(r.events, [{ kind: 'end', key: '', chars: 0 }]);
  assert.equal(r.out[0].event.delta.type, 'input_json_delta');
});

test("ACP: a session's prompt is replayed with tool calls, and its answer waits for the replay", async () => {
  const r = rig('acp');
  const chunk = (sessionId: string, text: string) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
  r.client({ jsonrpc: '2.0', id: 9, method: 'session/prompt', params: { sessionId: 'A', prompt: [{ type: 'text', text: '[bench] hi' }] } });
  r.client({ jsonrpc: '2.0', id: 10, method: 'session/prompt', params: { sessionId: 'B', prompt: [] } });
  r.agent(chunk('A', 'fake-acp'));
  r.agent(chunk('A', ': hi'));
  r.agent({
    method: 'session/update',
    params: { sessionId: 'A', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 't' } } },
  });
  r.agent({ jsonrpc: '2.0', id: 9, result: { stopReason: 'end_turn' } });
  r.agent({ jsonrpc: '2.0', id: 10, result: { stopReason: 'end_turn' } });
  r.agent({ jsonrpc: '2.0', id: 5, method: 'fs/read_text_file', params: { sessionId: 'B' } });
  r.agent({
    method: 'session/update',
    params: { sessionId: 'A', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } } },
  });
  r.runs[0].on.onChunk('xxx');
  r.runs[0].on.onTool(1);
  assert.deepEqual(
    r.out.map((m) => m.id ?? m.params.update.sessionUpdate),
    [10, 5, 'agent_message_chunk', 'tool_call', 'tool_call_update'],
  );
  assert.equal(r.out[2].params.update.content.text, 'xxx');
  assert.deepEqual(r.out[3].params.update, {
    sessionUpdate: 'tool_call',
    toolCallId: 'bench-tool-1',
    title: 'Read notes-1.md',
    kind: 'read',
    status: 'in_progress',
  });
  assert.equal(r.out[4].params.update.status, 'completed');
  r.client({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'A' } });
  r.client({ jsonrpc: '2.0', method: 'session/cancel', params: {} });
  r.client({ jsonrpc: '2.0', method: 'session/prompt', params: { sessionId: 'C' } });
  await r.rw.idle();
  assert.deepEqual(
    r.out.slice(5).map((m) => m.id ?? m.params.update.sessionUpdate),
    ['agent_thought_chunk', 9, 'agent_message_chunk'],
  );
  // the answer ended the session's stream: the next prompt's text is replayed afresh
  r.client({
    jsonrpc: '2.0',
    id: 11,
    method: 'session/prompt',
    params: { sessionId: 'A', prompt: [{ type: 'text', text: '[bench] more' }] },
  });
  r.agent(chunk('A', 'again'));
  assert.equal(r.runs.length, 2);
  r.runs[1].finish();
  await r.rw.idle();
});

test("only a turn the runner typed is replayed: MoPilot's own queries (a title, a probe) answer as the e2e fake does", async () => {
  const r = rig('codex');
  r.client({
    method: 'turn/start',
    params: { threadId: 'TITLE', input: [{ type: 'text', text: 'Summarize the request below… [bench] hi' }] },
  });
  r.client({ method: 'turn/start', params: { threadId: 'NONE' } });
  r.agent({ method: 'item/agentMessage/delta', params: { threadId: 'TITLE', turnId: 'u', itemId: 'i', delta: 'Fake chat title' } });
  assert.equal(r.runs.length, 0);
  assert.equal(r.out.at(-1).params.delta, 'Fake chat title');
  assert.equal(marked('[bench] x'), true);
  assert.equal(marked('x [bench]'), false);
  assert.equal(marked([{ type: 'image' }, null]), false);
  assert.equal(marked(undefined), false);
  assert.equal(MARK, '[bench]');
  // a reply of another stream does not use this one's arm, and the arm is used once
  const c = rig('acp');
  c.client({ id: 1, method: 'session/prompt', params: { sessionId: 'A', prompt: [{ type: 'text', text: '[bench] a' }] } });
  const chunk = (sessionId: string) => ({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } },
  });
  c.agent(chunk('B'));
  assert.equal(c.runs.length, 0);
  c.agent(chunk('A'));
  assert.equal(c.runs.length, 1);
  c.runs[0].finish();
  await c.rw.idle();
  c.agent({ id: 1, result: {} });
  c.agent(chunk('A'));
  assert.equal(c.runs.length, 1);
  // a marked prompt that never streamed is replaced by the next, unmarked one
  c.client({ id: 2, method: 'session/prompt', params: { sessionId: 'A', prompt: [{ type: 'text', text: '[bench] b' }] } });
  c.client({ id: 3, method: 'session/prompt', params: { sessionId: 'A', prompt: [{ type: 'text', text: 'no marker' }] } });
  c.agent(chunk('A'));
  assert.equal(c.runs.length, 1);
});
