// The three ways MoPilot's tools reach a harness (electron/capabilities/channels): Claude's
// in-process SDK MCP server, Codex's per-thread config and ACP's session/new mcpServers. Each is
// driven for real here: the Agent SDK's own server, and sage-mcp under the fake ACP agent.
import { waitFor } from './support/waitFor.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ensureSageMcp } from '../scripts/build-sage-mcp.mjs';

const require = createRequire(import.meta.url);
const z = require('zod');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');
const { sdkMcpServer, injectSdkMcp, autoAllow, readOnlyAllowedTools } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { sessionMcpServer, SessionMcp, sageMcpEnv } = require('../electron/capabilities/channels/sessionMcp.cjs');
const debugTools = require('../electron/capabilities/tools/debug.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function registry() {
  const r = new Registry();
  r.register(debugTools.echo);
  r.register({ name: 'sage_debug_poke', description: 'Changes something (tests only).', policy: 'act', handler: () => 'poked' });
  return r;
}

/* ---------- sdkMcp (Claude) ---------- */

async function connect(server: any) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

test("sdkMcp: each session gets its own SDK server; calls carry that session's chat and segment", async () => {
  const r = registry();
  const seen: any[] = [];
  r.setApprover(() => true);
  const orig = r.invoke.bind(r);
  r.invoke = (chatId: string, segmentId: string, tool: string, args: any, o: any) => (
    seen.push({ chatId, segmentId, tool, callId: o.callId }), orig(chatId, segmentId, tool, args, o)
  );
  const one = sdkMcpServer({ sdk, z, registry: r, serverName: 'sage_aaaaaaaaaaaa', owner: { chatId: 'chat-1', segmentId: 'seg-1' } });
  const two = sdkMcpServer({ sdk, z, registry: r, serverName: 'sage_bbbbbbbbbbbb', owner: { chatId: 'chat-2', segmentId: 'seg-2' } });
  assert.equal(one.type, 'sdk');
  assert.equal(one.name, 'sage_aaaaaaaaaaaa');
  assert.notEqual(one.instance, two.instance);

  const c1 = await connect(one);
  const listed = await c1.listTools();
  const echo = listed.tools.find((t: any) => t.name === 'sage_debug_echo')!;
  // always loaded: never deferred behind ToolSearch
  assert.equal(echo._meta?.['anthropic/alwaysLoad'], true);
  assert.equal(echo.annotations?.readOnlyHint, true);
  assert.deepEqual(echo.inputSchema.required, ['text']);
  assert.equal(listed.tools.find((t: any) => t.name === 'sage_debug_poke')!.annotations?.readOnlyHint, false);

  const res: any = await c1.callTool({
    name: 'sage_debug_echo',
    arguments: { text: 'quokka' },
    _meta: { 'claudecode/toolUseId': 'toolu_1' },
  });
  assert.deepEqual(res.content, [{ type: 'text', text: 'echo: quokka' }]);
  assert.equal(res.isError, false);
  const c2 = await connect(two);
  await c2.callTool({ name: 'sage_debug_poke', arguments: {} });
  assert.deepEqual(seen, [
    { chatId: 'chat-1', segmentId: 'seg-1', tool: 'sage_debug_echo', callId: 'toolu_1' },
    { chatId: 'chat-2', segmentId: 'seg-2', tool: 'sage_debug_poke', callId: null },
  ]);
  await c1.close();
  await c2.close();
});

test('sdkMcp: a call the SDK cancels (the CLI interrupting) aborts its Registry run', async () => {
  const r = registry();
  let started!: () => void;
  const running = new Promise<void>((res) => (started = res));
  const signals: AbortSignal[] = [];
  r.register({
    name: 'sage_debug_wait',
    description: 'Waits until stopped (tests only).',
    policy: 'observe',
    handler: (_a: any, ctx: any) => {
      signals.push(ctx.signal);
      started();
      return new Promise(() => {});
    },
  });
  const server = sdkMcpServer({ sdk, z, registry: r, serverName: 'sage_aaaaaaaaaaaa', owner: { chatId: 'chat-1', segmentId: 'seg-1' } });
  const client = await connect(server);
  const cancel = new AbortController();
  const call = client.callTool({ name: 'sage_debug_wait', arguments: {} }, undefined, { signal: cancel.signal }).catch((e: any) => e);
  await running;
  assert.equal(r.running.get('chat-1')?.size, 1);
  cancel.abort();
  await call;
  await waitFor(() => !r.running.has('chat-1'), 'the chat to stop running');
  assert.equal(signals[0].aborted, true, 'the handler sees ctx.signal abort');
  assert.equal(r.running.has('chat-1'), false, 'nothing still runs for the chat');
  await client.close();
});

test('an owner given as a resolver is looked up at each call: a session learns its chat after it opens', async () => {
  const r = registry();
  const seen: string[] = [];
  r.setApprover(() => true);
  const orig = r.invoke.bind(r);
  r.invoke = (chatId: string, segmentId: string, tool: string, args: any, o: any) => (
    seen.push(chatId), orig(chatId, segmentId, tool, args, o)
  );
  // the chat records the native session only later (a harness switch commits its segment after the start)
  let chat = 'native-1';
  const resolve = () => chat;
  const server = sdkMcpServer({ sdk, z, registry: r, serverName: 'sage_cccccccccccc', owner: { chatId: resolve, segmentId: 'native-1' } });
  const client = await connect(server);
  await client.callTool({ name: 'sage_debug_poke', arguments: {} });
  chat = 'chat-1';
  await client.callTool({ name: 'sage_debug_poke', arguments: {} });
  assert.deepEqual(seen, ['native-1', 'chat-1']);
  await client.close();
  // ToolSessions answers with the resolved chat, for sage-mcp's socket at each request
  const sessions = new ToolSessions();
  const { token } = sessions.open('k', { chatId: resolve, segmentId: 'native-1' });
  assert.equal(sessions.resolve(token).chatId, 'chat-1');
  chat = 'chat-2';
  assert.equal(sessions.get('k').chatId, 'chat-2');
  sessions.assign('k', { chatId: 'fixed' });
  assert.equal(sessions.get('k').chatId, 'fixed');
});

test('sdkMcp: injected into the options; read-only mode lists only tools that read', () => {
  const r = registry();
  const opts: any = { permissionMode: 'dontAsk', allowedTools: ['Read'] };
  assert.equal(
    injectSdkMcp(opts, { sdk, z, registry: r, serverName: 'sage_cccccccccccc', owner: { chatId: 'c', segmentId: 's' } }),
    'sage_cccccccccccc',
  );
  assert.deepEqual(Object.keys(opts.mcpServers), ['sage_cccccccccccc']);
  assert.deepEqual(opts.allowedTools, ['Read', 'mcp__sage_cccccccccccc__sage_debug_echo']);
  assert.deepEqual(readOnlyAllowedTools(r, 'sage_cccccccccccc'), ['mcp__sage_cccccccccccc__sage_debug_echo']);
  const plain: any = { permissionMode: 'default' };
  injectSdkMcp(plain, { sdk, z, registry: r, serverName: 'sage_cccccccccccc', owner: { chatId: 'c', segmentId: 's' } });
  assert.equal(plain.allowedTools, undefined);
  // no tools, no server
  const none: any = {};
  assert.equal(
    injectSdkMcp(none, { sdk, z, registry: new Registry(), serverName: 'sage_dddddddddddd', owner: { chatId: 'c', segmentId: 's' } }),
    null,
  );
  assert.equal(none.mcpServers, undefined);
});

test("sdkMcp: canUseTool lets through only the session's own random server", () => {
  const name = 'sage_eeeeeeeeeeee';
  assert.deepEqual(autoAllow(name, `mcp__${name}__sage_debug_echo`, { text: 'x' }), { behavior: 'allow', updatedInput: { text: 'x' } });
  assert.equal(autoAllow(name, 'mcp__sage__sage_debug_echo', {}), null);
  assert.equal(autoAllow(name, 'mcp__sage_ffffffffffff__sage_debug_echo', {}), null);
  assert.equal(autoAllow(name, 'Bash', {}), null);
});

/* ---------- sessionMcp (ACP) ---------- */

test('sessionMcp: a stdio entry with env as {name, value}', () => {
  assert.deepEqual(sessionMcpServer({ serverName: 'sage_123456789abc', command: '/x/sage-mcp', socketPath: '/tmp/s', token: 't' }), {
    name: 'sage_123456789abc',
    command: '/x/sage-mcp',
    args: [],
    env: Object.entries(sageMcpEnv({ socketPath: '/tmp/s', token: 't' })).map(([name, value]) => ({ name, value })),
  });
});

// built once per run, under a lock shared with the other test files (a failed build fails here, loudly)
const builtBin = ensureSageMcp({ log: console.error });
const skip = builtBin ? false : 'needs macOS with a swift toolchain to build sage-mcp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-channels-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The fake ACP agent with a minimal client. */
function acpAgent(logFile: string) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs')], {
    env: { ...process.env, FAKE_ACP_LOG: logFile },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map<number, (m: any) => void>();
  const said: string[] = [];
  let next = 1;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk') said.push(m.params.update.content.text);
      else if (m.id != null && !m.method) pending.get(m.id)?.(m);
    }
  });
  const request = (method: string, params: any) =>
    new Promise<any>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { child, said, request, close: () => new Promise((r) => (child.once('exit', r), child.stdin.end())) };
}

function setup(command: string, admissionMs = 10_000) {
  const sessions = new ToolSessions();
  const socket = new ToolSocket({ sessions, registry: registry() });
  const channel = new SessionMcp({ sessions, socket, command, admissionMs });
  const events: any[] = [];
  channel.on('admitted', (e: any) => events.push(['admitted', e]));
  channel.on('admission-failed', (e: any) => events.push(['admission-failed', e]));
  return { sessions, socket, channel, events };
}

test('sessionMcp: the fake ACP agent launches sage-mcp from session/new and the random word comes back', {
  skip,
  timeout: 30_000,
}, async () => {
  const bin = builtBin!;
  const { socket, channel, events } = setup(bin);
  const agent = acpAgent(path.join(dir, 'ok.jsonl'));
  try {
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { serverName, mcpServers } = await channel.prepare('acp-1', {
      harnessPid: agent.child.pid,
      chatId: 'chat-acp',
      segmentId: 'seg-acp',
    });
    const created = await agent.request('session/new', { cwd: dir, mcpServers });
    assert.ok(created.result.sessionId);
    assert.equal(await channel.admission('acp-1'), true);
    assert.deepEqual(events, [['admitted', { key: 'acp-1', serverName }]]);
    const word = `w${Math.random().toString(36).slice(2, 8)}`;
    const done = await agent.request('session/prompt', {
      sessionId: created.result.sessionId,
      prompt: [{ type: 'text', text: `MCPCALL ${word}` }],
    });
    assert.equal(done.result.stopReason, 'end_turn');
    assert.equal(agent.said.join(''), `fake-acp: MCPCALL ${word} [mcp ${serverName}: echo: ${word}]`);
    const log = readJsonLineLog(path.join(dir, 'ok.jsonl'));
    const mcp = log.find((e) => e.kind === 'mcp');
    assert.equal(mcp.ok, true);
    assert.equal(mcp.serverInfo.name, serverName);
    assert.deepEqual(mcp.tools, ['sage_debug_echo', 'sage_debug_poke']);
  } finally {
    await agent.close();
    socket.close();
  }
});

test('sessionMcp: no handshake within the admission window is an admission-failed event', { skip, timeout: 30_000 }, async () => {
  const bin = builtBin!;
  // a harness pid that isn't the agent or anything above sage-mcp (an unrelated process): main refuses sage-mcp's
  // hello, so the session never gets tools
  const { socket, channel, events } = setup(bin, 1500);
  const agent = acpAgent(path.join(dir, 'pid.jsonl'));
  const stranger = spawn('/bin/sleep', ['30']);
  try {
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { serverName, mcpServers } = await channel.prepare('acp-2', { harnessPid: stranger.pid });
    const admitted = channel.admission('acp-2');
    await agent.request('session/new', { cwd: dir, mcpServers });
    assert.equal(await admitted, false);
    assert.equal(events.length, 1);
    assert.equal(events[0][0], 'admission-failed');
    assert.equal(events[0][1].key, 'acp-2');
    assert.equal(events[0][1].serverName, serverName);
    assert.match(events[0][1].reason, /no handshake/);
  } finally {
    stranger.kill();
    await agent.close();
    socket.close();
  }

  // and a sage-mcp that can't even start
  const missing = setup(path.join(dir, 'no-such-sage-mcp'), 1500);
  const agent2 = acpAgent(path.join(dir, 'missing.jsonl'));
  try {
    await agent2.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { mcpServers } = await missing.channel.prepare('acp-3', { harnessPid: agent2.child.pid });
    await agent2.request('session/new', { cwd: dir, mcpServers });
    assert.equal(await missing.channel.admission('acp-3'), false);
    assert.equal(missing.events[0][0], 'admission-failed');
  } finally {
    await agent2.close();
    missing.socket.close();
  }
});
