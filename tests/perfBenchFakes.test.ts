// The streaming benchmark's fake harnesses (scripts/perf-bench/fake-*.mjs) on their wire protocols: each runs a turn as MoPilot
// drives it, streams the benchmark's reply in deltas of the asked size behind the run's gate, and reports the turn to the runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { makeReply } from '../scripts/perf-bench/replay.mjs';
import { runFake } from '../scripts/perf-bench/proxy.mjs';

const BENCH = path.join(import.meta.dirname, '..', 'scripts', 'perf-bench');

/** A fake started as MoPilot starts it, with a scratch home and control folder. */
function start(fake: string, args: string[], replay: Record<string, unknown> | null, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-fake-'));
  const ctl = path.join(dir, 'ctl');
  const home = path.join(dir, 'home');
  fs.mkdirSync(ctl);
  fs.mkdirSync(home);
  if (replay) fs.writeFileSync(path.join(ctl, 'replay.json'), JSON.stringify(replay));
  const child = spawn(process.execPath, [path.join(BENCH, fake), ...args], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      PERF_BENCH_CONTROL: ctl,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines: any[] = [];
  readline.createInterface({ input: child.stdout! }).on('line', (l) => lines.push(l.startsWith('{') ? JSON.parse(l) : l));
  const exited = new Promise<number | null>((r) => child.on('close', r));
  return {
    ctl,
    lines,
    exited,
    send: (msg: unknown) => child.stdin!.write(`${JSON.stringify(msg)}\n`),
    async until<T>(find: () => T | undefined, ms = 10_000): Promise<T> {
      const end = Date.now() + ms;
      for (;;) {
        const v = find();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(lines).slice(-2000)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    events: () => readJsonLineLog(path.join(ctl, 'events.jsonl')),
    go: () => fs.writeFileSync(path.join(ctl, 'go'), ''),
    end: () => child.stdin!.end(),
  };
}

const REPLAY = { mode: 'replay', bytes: 300, rate: 5000, chunk: 32, gate: true };

test('the Codex fake streams the reply in 32-character deltas behind the gate, and completes the item with it', async () => {
  const f = start('fake-app-server.mjs', ['app-server'], REPLAY);
  f.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'bench', version: '1' } } });
  f.send({ method: 'initialized' });
  f.send({ id: 2, method: 'thread/start', params: {} });
  const threadId = await f.until(() => f.lines.find((m) => m.id === 2)?.result.thread.id);
  f.send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: '[bench] go' }] } });
  await f.until(() => f.lines.find((m) => m.id === 3));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(f.lines.filter((m) => m.method === 'item/agentMessage/delta').length, 0, 'held at the gate');
  f.go();
  const done = await f.until(() => f.lines.find((m) => m.method === 'turn/completed'));
  const deltas = f.lines.filter((m) => m.method === 'item/agentMessage/delta').map((m) => m.params.delta);
  assert.equal(deltas.join(''), makeReply(300));
  assert.ok(deltas.slice(0, -1).every((d) => d.length === 32));
  const item = f.lines.find((m) => m.method === 'item/completed' && m.params.item.type === 'agentMessage').params.item;
  assert.equal(item.text, makeReply(300));
  assert.equal(done.params.turn.items.find((i: any) => i.type === 'agentMessage').text, makeReply(300));
  assert.ok(f.lines.indexOf(done) > f.lines.findLastIndex((m) => m.method === 'item/agentMessage/delta'));
  assert.deepEqual(
    f.events().map((e) => [e.protocol, e.kind, e.key, e.chars]),
    [
      ['codex', 'start', threadId, undefined],
      ['codex', 'end', threadId, 300],
    ],
  );
  f.end();
  assert.equal(await f.exited, 0);
});

test('the Claude Code fake answers --version as the e2e fake does, and streams the reply with its result', async () => {
  const v = start('fake-claude.mjs', ['--version'], null);
  assert.equal(await v.exited, 0);
  assert.match(v.lines[0], /Claude Code/);

  const f = start('fake-claude.mjs', ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], {
    ...REPLAY,
    gate: false,
  });
  f.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'initialize' } });
  await f.until(() => f.lines.find((m) => m.type === 'control_response'));
  f.send({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[bench] go' }] },
    parent_tool_use_id: null,
    session_id: '',
  });
  const result = await f.until(() => f.lines.find((m) => m.type === 'result'));
  const deltas = f.lines.filter((m) => m.type === 'stream_event' && m.event.type === 'content_block_delta').map((m) => m.event.delta.text);
  assert.equal(deltas.join(''), makeReply(300));
  assert.equal(result.result, makeReply(300));
  const msg = f.lines.find((m) => m.type === 'assistant');
  assert.equal(msg.message.content[0].text, makeReply(300));
  f.end();
  assert.equal(await f.exited, 0);
  assert.deepEqual(
    f.events().map((e) => [e.protocol, e.kind]),
    [
      ['claude', 'start'],
      ['claude', 'end'],
    ],
  );
});

test('the ACP fake streams the reply with a tool call pair between deltas, and answers the prompt after it', async () => {
  const f = start('fake-acp.mjs', [], { mode: 'replay', bytes: 200, rate: 50, chunk: 40, toolEveryMs: 120, gate: false });
  f.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  await f.until(() => f.lines.find((m) => m.id === 1));
  f.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: os.tmpdir(), mcpServers: [] } });
  const sessionId = await f.until(() => f.lines.find((m) => m.id === 2)?.result.sessionId);
  f.send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: '[bench] go' }] } });
  const answer = await f.until(() => f.lines.find((m) => m.id === 3));
  assert.equal(answer.result.stopReason, 'end_turn');
  const updates = f.lines.filter((m) => m.method === 'session/update' && m.params.sessionId === sessionId).map((m) => m.params.update);
  const text = updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text);
  assert.equal(text.join(''), makeReply(200));
  // 50 tokens/s of 40-character deltas: one every 200 ms, so a 120 ms tool call lands between the first two
  const kinds = updates.map((u) => u.sessionUpdate);
  assert.deepEqual(kinds.slice(0, 4), ['agent_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  assert.ok(f.lines.indexOf(answer) > f.lines.findLastIndex((m) => m.method === 'session/update'));
  f.end();
  assert.equal(await f.exited, 0);
});

test('the fake runs in this process: its stdout is rewritten line by line, its stdin is what the client wrote, and its exit waits for a reply', async () => {
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  const written: string[] = [];
  const exits: number[] = [];
  const proc: any = { stdin, stdout: { write: (s: string) => (written.push(s), true) }, exit: (c?: number) => void exits.push(c ?? -1) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-proxy-'));
  fs.writeFileSync(path.join(dir, 'replay.json'), JSON.stringify({ mode: 'replay', text: 'abcdef', rate: 1000, chunk: 3 }));
  const got: string[] = [];
  let fake: any;
  await runFake('acp', new URL('file:///inner.mjs'), {
    env: { PERF_BENCH_CONTROL: dir },
    proc,
    load: async (url) => {
      assert.equal(url.href, 'file:///inner.mjs');
      // the stand-in fake: reads its stdin, writes JSON in pieces and as bytes
      fake = proc;
      readline.createInterface({ input: proc.stdin }).on('line', (l) => got.push(l));
    },
  });
  stdin.write(
    `${JSON.stringify({ id: 1, method: 'session/prompt', params: { sessionId: 'A', prompt: [{ type: 'text', text: '[bench] x' }] } })}\n`,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(JSON.parse(got[0]).method, 'session/prompt');
  const chunk = JSON.stringify({
    method: 'session/update',
    params: { sessionId: 'A', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'orig' } } },
  });
  fake.stdout.write(chunk.slice(0, 10));
  fake.stdout.write(Buffer.from(chunk.slice(10, 20)), () => undefined);
  fake.stdout.write(Buffer.from(`${chunk.slice(20)}\n`), 'utf8');
  fake.stdout.write(`${JSON.stringify({ id: 1, result: { stopReason: 'end_turn' } })}\n`, 'utf8', () => undefined);
  fake.exit(0);
  fake.exit(5);
  assert.deepEqual(exits, [], 'waits for the reply');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(exits, [0]);
  const out = written.map((l) => JSON.parse(l));
  assert.deepEqual(
    out.map((m) => m.params?.update?.content?.text ?? m.result?.stopReason),
    ['abc', 'def', 'end_turn'],
  );
  stdin.end();
  // nothing playing: an exit is at once
  const exits2: number[] = [];
  const proc2: any = { stdin: new PassThrough(), stdout: { write: () => true }, exit: (c?: number) => void exits2.push(c ?? -1) };
  await runFake('codex', new URL('file:///inner.mjs'), { env: {}, proc: proc2, load: async () => proc2.exit() });
  assert.deepEqual(exits2, [0]);
  proc2.stdin.end();
});
