// SessionMcp offering MoPilot's http tool channel (electron/capabilities/httpMcp.cjs) in session/new, and a fake
// harness that refuses stdio MCP servers, as Copilot CLI does, reaching the tools and being admitted over it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const require = createRequire(import.meta.url);
const { ToolHttp } = require('../electron/capabilities/httpMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { SessionMcp, sessionMcpHttpServer } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { probe } = require('../electron/harness/admission.cjs');
const debugTools = require('../electron/capabilities/tools/debug.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-mcp-session-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const channels: any[] = [];
after(() => channels.forEach((c) => c.close()));

/* -- SessionMcp over http ----------------------------------------------- */

function channel(withHttp = true, admissionMs = 2000) {
  const sessions = new ToolSessions();
  const registry = new Registry();
  registry.register(debugTools.echo);
  const socket = new ToolSocket({ sessions, registry });
  const h = withHttp ? new ToolHttp({ sessions, registry, verifyPeer: async () => null }) : null;
  channels.push(socket);
  if (h) channels.push(h);
  const mcp = new SessionMcp({ sessions, socket, http: h, command: '/no/sage-mcp', admissionMs });
  const events: any[] = [];
  mcp.on('admitted', (e: any) => events.push(['admitted', e]));
  mcp.on('admission-failed', (e: any) => events.push(['admission-failed', e]));
  return { sessions, mcp, h, events };
}

test('sessionMcp: an http entry carries the url and the token as a bearer header', () => {
  assert.deepEqual(sessionMcpHttpServer({ serverName: 'sage_123456789abc', url: 'http://127.0.0.1:9/mcp', token: 't' }), {
    type: 'http',
    name: 'sage_123456789abc',
    url: 'http://127.0.0.1:9/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer t' }],
  });
});

test('sessionMcp: with http the entry is the endpoint, else sage-mcp; without an endpoint it stays sage-mcp', async () => {
  const c = channel();
  const viaHttp = await c.mcp.prepare('a', { harnessPid: 1, http: true });
  assert.equal(viaHttp.mcpServers[0].type, 'http');
  assert.equal(viaHttp.mcpServers[0].url, await c.h!.listen());
  assert.equal((await c.mcp.prepare('b', { harnessPid: 1 })).mcpServers[0].command, '/no/sage-mcp');
  const noEndpoint = channel(false);
  assert.equal((await noEndpoint.mcp.prepare('a', { harnessPid: 1, http: true })).mcpServers[0].command, '/no/sage-mcp');
});

test("sessionMcp: the harness's initialize over http admits the session; none in time does not", async () => {
  const c = channel(true, 300);
  const { serverName, mcpServers } = await c.mcp.prepare('a', { harnessPid: 1, http: true });
  const admitted = c.mcp.admission('a');
  const client = new Client({ name: 'copilot-like', version: '0' });
  const [{ url, headers }] = mcpServers;
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { [headers[0].name]: headers[0].value } } }),
  );
  assert.equal(await admitted, true);
  await client.close();
  await c.mcp.prepare('b', { harnessPid: 1, http: true });
  assert.equal(await c.mcp.admission('b'), false);
  assert.deepEqual(
    c.events.map((e) => [e[0], e[1].key]),
    [
      ['admitted', 'a'],
      ['admission-failed', 'b'],
    ],
  );
  assert.equal(c.events[0][1].serverName, serverName);
});

/* -- a harness that refuses stdio MCP servers, end to end --------------- */

/** The fake ACP agent with a minimal client. */
function acpAgent(profile: object, logFile: string) {
  const child = spawn(process.execPath, [AGENT], {
    env: { ...process.env, FAKE_ACP_LOG: logFile, FAKE_ACP_PROFILE: JSON.stringify(profile) },
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
const logOf = (file: string) => readJsonLineLog(file);

test('a harness that refuses stdio servers reaches the tools over http and calls one', { timeout: 30_000 }, async () => {
  const c = channel(true, 10_000);
  const log = path.join(dir, 'http.jsonl');
  const agent = acpAgent({ rejectStdio: true, httpMcp: true }, log);
  try {
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const { serverName, mcpServers } = await c.mcp.prepare('acp-1', { harnessPid: agent.child.pid, chatId: 'chat', http: true });
    const created = await agent.request('session/new', { cwd: dir, mcpServers });
    assert.equal(await c.mcp.admission('acp-1'), true);
    const done = await agent.request('session/prompt', {
      sessionId: created.result.sessionId,
      prompt: [{ type: 'text', text: 'MCPCALL w1' }],
    });
    assert.equal(done.result.stopReason, 'end_turn');
    assert.equal(agent.said.join(''), `fake-acp: MCPCALL w1 [mcp ${serverName}: echo: w1]`);
    const mcp = logOf(log).find((e) => e.kind === 'mcp');
    assert.deepEqual([mcp.ok, mcp.serverInfo.name, mcp.tools], [true, serverName, ['sage_debug_echo']]);
    // offered sage-mcp instead, it refuses it as Copilot CLI does
    const stdio = await c.mcp.prepare('acp-2', { harnessPid: agent.child.pid });
    await agent.request('session/new', { cwd: dir, mcpServers: stdio.mcpServers });
    assert.ok(logOf(log).some((e) => e.kind === 'mcp' && e.error === 'Rejecting non-http/sse MCP server'));
  } finally {
    await agent.close();
  }
});

test('admission: a harness whose quirks say mcpStdio false is admitted over http', { timeout: 30_000 }, async () => {
  const c = channel(true, 10_000);
  const q = {
    label: 'Fake Copilot',
    bins: ['fake'],
    args: [AGENT],
    privacyDefaults: [],
    admission: { handshakeTimeoutMs: 10_000 },
    mcpStdio: false,
    env: { FAKE_ACP_PROFILE: JSON.stringify({ rejectStdio: true, httpMcp: true }), FAKE_ACP_LOG: path.join(dir, 'probe.jsonl') },
  };
  const r = await probe('copilot', {
    quirks: () => q,
    resolveBin: () => process.execPath,
    env: () => process.env,
    tools: c.mcp,
    dataDir: dir,
  });
  assert.equal(r.state, 'admitted', r.reason);
  assert.equal(c.events[0][0], 'admitted');
});
