// Exercises the scripted Codex fixture's MCP configuration, framing, approvals and interrupted tool items.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

class Child extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: (_encoding: string) => {} });
  stderr = Object.assign(new EventEmitter(), { setEncoding: (_encoding: string) => {} });
  writes: any[] = [];
  reply: (message: any) => any = (message) => {
    if (message.method === 'initialize')
      return this.mode === 'init-error' ? { error: { message: 'init failed' } } : { result: { serverInfo: { name: 'test' } } };
    if (message.method === 'tools/list')
      return {
        result: {
          tools: this.mode === 'missing' ? [] : [{ name: 'sage_debug_echo', annotations: { readOnlyHint: this.mode === 'readonly' } }],
        },
      };
    if (this.mode === 'call-error') return { error: { message: 'call failed' } };
    return { result: { content: [{ type: 'text', text: message.params.arguments.text ?? 'answer' }] } };
  };
  stdin = Object.assign(new EventEmitter(), {
    write: (text: string) => {
      const message = JSON.parse(text);
      this.writes.push(message);
      if (message.id == null) return;
      const response = this.reply(message);
      if (response) this.respond(message.id, response);
    },
  });
  mode: string;
  constructor(mode: string) {
    super();
    this.mode = mode;
  }
  respond(id: number, response: any) {
    const text = JSON.stringify({ id, ...response }) + '\n';
    this.stdout.emit('data', 'not-json\n' + text.slice(0, 5));
    this.stdout.emit('data', text.slice(5));
  }
  kill() {
    this.emit('exit', 0);
    return true;
  }
}
const children: Child[] = [];
const launches: any[] = [];
mock.module('node:child_process', {
  namedExports: {
    spawn: (...args: any[]) => {
      launches.push(args);
      const child = new Child(args[0]);
      children.push(child);
      return child;
    },
  },
});
const { createFakeCodexMcp } = await import('./e2e/fixtures/fake-codex-mcp.mjs');
function fixture() {
  const events: any[] = [];
  const logs: any[] = [];
  const waiting = new Map<string, () => void>();
  return {
    events,
    logs,
    waiting,
    ...createFakeCodexMcp({
      version: 'test-version',
      log: (entry: any) => logs.push(entry),
      notify: (method: string, params: any) => events.push({ method, params }),
      waiting,
    }),
  };
}

test('MCP configuration preserves clients without new config, frames replies and replaces old children', async () => {
  const f = fixture();
  const rec: any = {};
  f.useMcpConfig(rec, {
    mcp_servers: { one: { command: 'normal', args: ['arg'], env: { FIXTURE_ENV: 'value' } }, remote: { url: 'https://example.test' } },
  });
  const client = rec.mcp.get('one');
  await client.ready;
  const child = children.at(-1)!;
  assert.equal(child.writes[0].params.clientInfo.version, 'test-version');
  assert.equal(child.writes[1].method, 'notifications/initialized');
  assert.deepEqual(launches.at(-1)!.slice(0, 2), ['normal', ['arg']]);
  assert.equal(launches.at(-1)![2].env.FIXTURE_ENV, 'value');
  assert.equal(launches.at(-1)![2].env.PATH, process.env.PATH);
  assert.equal(rec.mcp.size, 1);
  f.useMcpConfig(rec, {});
  assert.equal(rec.mcp.get('one'), client);
  let stopped = false;
  child.once('exit', () => {
    stopped = true;
  });
  f.useMcpConfig(rec, { mcp_servers: { next: { command: 'normal' } } });
  assert.equal(stopped, true);
  assert.deepEqual([...rec.mcp.keys()], ['next']);
  await rec.mcp.get('next').ready;
  const next = children.at(-1)!;
  next.reply = () => undefined;
  const pending = rec.mcp.get('next').request('tools/list', {});
  next.stderr.emit('data', 'fixture error ');
  next.emit('exit', 3);
  assert.deepEqual(await pending, { error: { message: 'exited (3) fixture error' } });
  next.emit('error', new Error('child error'));
  next.stdin.emit('error', new Error('write error'));
});

test('MCP echo preserves initialization failures, missing tools, approval policy and peer errors', async () => {
  for (const [mode, approval, expected] of [
    ['init-error', 'approve', 'init failed'],
    ['missing', 'approve', 'no sage_debug_echo'],
    ['normal', 'never', 'MCP tool call requires approval, but approval policy is never'],
    ['readonly', 'never', 'word'],
    ['normal', 'approve', 'word'],
    ['call-error', 'approve', 'call failed'],
  ]) {
    const f = fixture();
    const rec: any = {};
    const configure = f.useMcpConfig;
    configure(rec, { mcp_servers: { server: { command: mode, default_tools_approval_mode: approval } } });
    assert.deepEqual(await f.callMcp(rec, 'thread', 'word'), [`server: ${expected}`]);
    assert.equal(f.logs[0].threadId, 'thread');
    assert.equal(f.logs[0].server, 'server');
    assert.equal(f.logs[0].text ?? f.logs[0].error, expected);
    for (const client of rec.mcp.values()) client.kill();
  }
  assert.deepEqual(await fixture().callMcp({}, 'thread', 'word'), []);
});

test('MCP host calls retain ordered item notifications, results, errors and shared-map interruption', async () => {
  const f = fixture();
  assert.deepEqual(await f.callHostTools({}, { items: [] }, 'thread', 'turn', 'hello'), { text: '', interrupted: false });
  assert.deepEqual(await f.callHostTools({}, { items: [] }, 'thread', 'turn', 'MCPCU click {}'), {
    text: ' [cu: no sage server]',
    interrupted: false,
  });
  const rec: any = {};
  f.useMcpConfig(rec, { mcp_servers: { sage_123456abcdef: { command: 'normal' } } });
  await rec.mcp.get('sage_123456abcdef').ready;
  const child = children.at(-1)!;
  child.reply = (message) =>
    message.params.name === 'image'
      ? { result: { content: [{ type: 'image' }, { type: 'text', text: 'image result' }], isError: true } }
      : { error: { message: 'peer failed' } };
  const turn = { items: [] as any[] };
  const written = await f.callHostTools(rec, turn, 'thread', 'turn', 'MCPCU image {}\nMCPCU fail {}');
  assert.deepEqual(written, { text: ' [cu: error: <image> image result] [cu: peer failed]', interrupted: false });
  assert.deepEqual(
    f.events.map((e) => e.method),
    ['item/started', 'item/completed', 'item/started', 'item/completed'],
  );
  assert.deepEqual(
    turn.items.map((i) => i.status),
    ['failed', 'failed'],
  );
  assert.equal(turn.items[0].result.content[0].type, 'image');
  assert.equal(turn.items[1].error.message, 'peer failed');
  // the reply is still to be written: a Stop that lands then reaches the caller through the result (#4704)
  assert.deepEqual([...f.waiting.keys()], ['turn']);
  f.waiting.get('turn')!();
  assert.equal(written.interrupted, true);
  f.waiting.delete('turn');
  assert.ok(turn.items.every((i) => i.durationMs >= 1));
  child.reply = () => undefined;
  const interrupted = f.callHostTools(rec, turn, 'thread', 'interrupted', 'MCPCU wait {}\nMCPCU never {}');
  await Promise.resolve();
  f.waiting.get('interrupted')!();
  assert.deepEqual(await interrupted, { text: ' [cu: interrupted]', interrupted: true });
  assert.equal(turn.items.at(-1).error.message, 'interrupted');
  assert.equal(turn.items.length, 3);
  assert.equal(f.waiting.has('interrupted'), true, 'the interrupt owner retains cleanup responsibility');
  child.kill();
});

test('empty MCP peer replies retain fallback metadata and host-call completion states', async () => {
  const f = fixture();
  const client = { ready: Promise.resolve({}), request: async () => ({}) };
  const rec = { mcp: new Map([['sage_123456abcdef', client]]), mcpConfig: { sage_123456abcdef: {} } };
  assert.deepEqual(await f.callMcp(rec, 'thread', 'word'), ['sage_123456abcdef: no sage_debug_echo']);
  assert.equal(f.logs[0].serverInfo, null);
  assert.deepEqual(f.logs[0].tools, []);
  const turn = { items: [] as any[] };
  assert.deepEqual(await f.callHostTools(rec, turn, 'thread', 'empty', 'MCPCU empty {}'), { text: ' [cu: no answer]', interrupted: false });
  assert.equal(turn.items[0].status, 'failed');
  assert.equal(turn.items[0].error.message, 'no answer');
  client.request = async () => ({ result: { content: [] } });
  assert.deepEqual(await f.callHostTools(rec, turn, 'thread', 'success', 'MCPCU empty {}'), {
    text: ' [cu: no answer]',
    interrupted: false,
  });
  assert.equal(turn.items[1].status, 'completed');
  assert.deepEqual(turn.items[1].result, { content: [], structuredContent: null });
  assert.deepEqual([...f.waiting.keys()], ['empty', 'success'], 'each finished turn leaves its hook for the reply being written');
});
