// Drives tests/fixtures/fake-acp-agent.mjs with a tiny ACP client to show the fixture works.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcError, errorReply } from './fixtures/acpError.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const MCP_SERVER = path.join(ROOT, 'tests/conformance/lib/mcp-server.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-acp-'));
const logFile = path.join(dir, 'agent.jsonl');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A minimal ACP client: requests, notifications, and answers to the agent's own requests. */
function client(onRequest: (method: string, params: any) => any) {
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, FAKE_ACP_LOG: logFile }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (m: any) => void>();
  const updates: any[] = [];
  let next = 1;
  let buf = '';
  const write = (m: any) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', async (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      assert.equal(m.jsonrpc, '2.0');
      if (m.method === 'session/update') updates.push(m.params);
      else if (m.method && m.id != null) write({ id: m.id, result: await onRequest(m.method, m.params) });
      else if (m.id != null) pending.get(m.id)?.(m);
    }
  });
  return {
    updates,
    request: (method: string, params: any) =>
      new Promise<any>((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        write({ id, method, params });
      }),
    notify: (method: string, params: any) => write({ method, params }),
    close: () => new Promise((r) => (child.once('exit', r), child.stdin.end())),
  };
}

const readLog = () => readJsonLineLog(logFile);
const said = (updates: any[], sessionId: string) =>
  updates
    .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk')
    .map((u) => u.update.content.text)
    .join('');

test('shared ACP fixture framing preserves structured native errors and plain failure fallbacks', () => {
  const error = { code: -32603, message: 'Internal error', data: { details: 'No API key found for vendor' } };
  const parsed = JSON.parse(JSON.stringify(errorReply(7, new RpcError(error.code, error.message, error.data))));
  assert.deepEqual(parsed, { id: 7, error });
  assert.deepEqual(JSON.parse(JSON.stringify(errorReply(8, 'plain', -32000))), { id: 8, error: { code: -32000, message: 'plain' } });
});

test('initialize, session/new with an MCP server, prompt, permission and cancel', async () => {
  const permissions: any[] = [];
  const c = client((method, params) => {
    assert.equal(method, 'session/request_permission');
    permissions.push(params);
    return { outcome: { outcome: 'selected', optionId: 'allow' } };
  });
  try {
    const init = await c.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    assert.equal(init.result.protocolVersion, 1);
    assert.deepEqual(init.result.agentCapabilities.mcpCapabilities, { http: true, sse: false });

    const mcpServers = [
      { name: 'sage', command: process.execPath, args: [MCP_SERVER, 'HELLO'], env: [{ name: 'X_TEST', value: '1' }] },
      { type: 'http', name: 'remote', url: 'http://127.0.0.1:9/mcp', headers: [] },
    ];
    const created = await c.request('session/new', { cwd: dir, mcpServers });
    const sessionId = created.result.sessionId;
    assert.match(sessionId, /^fake-acp-session-/);
    const log = readLog();
    assert.deepEqual(log.find((e) => e.kind === 'session').mcpServers, mcpServers);
    const mcp = log.filter((e) => e.kind === 'mcp');
    assert.deepEqual(
      mcp.map((e) => [e.name, e.ok, e.serverInfo?.name, e.tools]),
      [['sage', true, 'sage-test', ['sage_screenshot']]],
    );

    // a plain prompt streams the echo and ends the turn
    const r1 = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello there' }] });
    assert.deepEqual(r1.result, { stopReason: 'end_turn' });
    assert.equal(said(c.updates, sessionId), 'fake-acp: hello there');

    // PERMIT asks the client first, then reports the tool call's outcome
    c.updates.length = 0;
    const r2 = await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'PERMIT it' }] });
    assert.deepEqual(r2.result, { stopReason: 'end_turn' });
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].sessionId, sessionId);
    assert.deepEqual(
      permissions[0].options.map((o: any) => o.kind),
      ['allow_once', 'reject_once'],
    );
    const kinds = c.updates.map((u) => u.update.sessionUpdate);
    assert.deepEqual(kinds.slice(0, 2), ['tool_call', 'tool_call_update']);
    assert.equal(c.updates[1].update.status, 'completed');
    assert.equal(said(c.updates, sessionId), 'fake-acp: PERMIT it');

    // SLOW waits until session/cancel
    const r3 = c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'SLOW one' }] });
    await new Promise((r) => setTimeout(r, 50));
    c.notify('session/cancel', { sessionId });
    assert.deepEqual((await r3).result, { stopReason: 'cancelled' });

    // errors
    assert.equal((await c.request('session/prompt', { sessionId: 'nope', prompt: [] })).error.code, -32602);
    assert.equal((await c.request('session/load', { sessionId })).error.code, -32601);
    assert.equal((await c.request('session/new', { cwd: 'relative', mcpServers: [] })).error.code, -32602);
  } finally {
    await c.close();
  }
  // everything in and out is in the log
  const log = readLog();
  assert.ok(log.some((e) => e.kind === 'in' && e.msg.method === 'session/cancel'));
  assert.ok(log.some((e) => e.kind === 'out' && e.msg.method === 'session/request_permission'));
});

test('a rejected permission fails the tool call; an MCP server that cannot start is logged', async () => {
  const c = client(() => ({ outcome: { outcome: 'selected', optionId: 'reject' } }));
  try {
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { result } = await c.request('session/new', {
      cwd: dir,
      mcpServers: [{ name: 'broken', command: path.join(dir, 'missing'), args: [], env: [] }],
    });
    const mcp = readLog().filter((e) => e.kind === 'mcp' && e.sessionId === result.sessionId);
    assert.deepEqual(
      mcp.map((e) => [e.name, e.ok]),
      [['broken', false]],
    );
    const r = await c.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'PERMIT' }] });
    assert.deepEqual(r.result, { stopReason: 'end_turn' });
    assert.equal(c.updates.find((u) => u.update.sessionUpdate === 'tool_call_update').update.status, 'failed');
  } finally {
    await c.close();
  }
});

test('SUBAGENT runs a sub-agent call with one child call that names it as parent, then completes with a report', async () => {
  const c = client(() => ({}));
  try {
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { result } = await c.request('session/new', { cwd: dir, mcpServers: [] });
    await c.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'SUBAGENT 20 now' }] });
    const calls = c.updates.map((u) => u.update).filter((u) => u.toolCallId);
    const agent = calls.find((u) => u.sessionUpdate === 'tool_call' && u.rawInput?.subagent_type);
    const child = calls.find((u) => u.sessionUpdate === 'tool_call' && u.kind === 'execute');
    assert.equal(agent.rawInput.description, 'Track Z: check things');
    assert.equal(child._meta.claudeCode.parentToolUseId, agent.toolCallId);
    const done = calls.filter((u) => u.sessionUpdate === 'tool_call_update').map((u) => [u.toolCallId === agent.toolCallId, u.status]);
    assert.deepEqual(done, [
      [false, 'completed'],
      [true, 'completed'],
    ]);
    // a bare SUBAGENT uses the short default wait
    c.updates.length = 0;
    await c.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'SUBAGENT' }] });
    assert.equal(c.updates.filter((u) => u.update.toolCallId).length, 4);
  } finally {
    await c.close();
  }
});

test('SPEND <model> <in> <out> ends the prompt with a usage report of that model, and a plain prompt reports none', async () => {
  const c = client(() => ({}));
  try {
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { result } = await c.request('session/new', { cwd: dir, mcpServers: [] });
    const ask = (text: string) => c.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text }] });
    assert.deepEqual((await ask('SPEND claude-haiku-4-5 10000 20000')).result.usage, {
      model: 'claude-haiku-4-5',
      inputTokens: 10000,
      outputTokens: 20000,
    });
    assert.equal('usage' in (await ask('no spend here')).result, false);
  } finally {
    c.close();
  }
});
