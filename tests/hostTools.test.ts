// The Host's tool channel (host/src/tools.mjs): an ACP chat's session is given the portable sage-mcp, which reaches the Host's tool socket over a unix socket; the registry's tools answer, a token the Host did not issue gets nothing, and a machine that cannot check who connects serves no tools (W: wrong peer, A: ending a session, B: unavailable platform).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { readJsonLineLog } from '../scripts/fixture-json-log.mjs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { createHostTools } from '../host/src/tools.mjs';
import { hostStatus } from '../host/src/status.mjs';
import { fakeCore, READY_ROUTES } from './support/fake-core.ts';

const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const SHIM = path.join(ROOT, 'host/bin/sage-mcp.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-tools-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const echo = {
  name: 'host_echo',
  description: 'Echo the text back.',
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  policy: 'observe',
  handler: ({ text }: { text: string }) => `host-echo: ${text}`,
};

/** A Host's sessions over the fake ACP agent, which starts the sage-mcp it is given in session/new. */
function setup(tools: ReturnType<typeof createHostTools>) {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const log = path.join(dir, 'agent.jsonl');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({
      fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 's'), FAKE_ACP_LOG: log } },
    }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { tools: tools.mcp } });
  const sessions = createHostSessions({ paths, env: {}, runtime });
  const agentLog = () => readJsonLineLog(log);
  return { dir, sessions, agentLog, close: () => (sessions.close(), runtime.close(), tools.close()) };
}

test('an ACP chat is admitted through the portable sage-mcp and its tool call is answered by the registry', {
  timeout: 60_000,
}, async () => {
  const tools = createHostTools({ register: (r: any) => r.register(echo) });
  assert.equal(tools.available, true);
  const h = setup(tools);
  try {
    const events: any[] = [];
    h.sessions.chatRuntime.host.on('event', (e: any) => events.push(e));
    await h.sessions.chatRuntime.send({ key: 'acp:fake:t', text: 'MCPTOOL host_echo {"text":"hi"}', cwd: h.dir });
    await until(() => events.some((e) => e.kind === 'turnEnd'));
    const reply = events
      .filter((e) => e.update?.sessionUpdate === 'agent_message_chunk')
      .map((e) => e.update.content.text)
      .join('');
    assert.match(reply, /host-echo: hi/);
    // the agent was given the Host's own shim, run by the Host's node, and connected to it
    const created = h.agentLog().find((l: any) => l.kind === 'session');
    assert.equal(created.mcpServers[0].command, process.execPath);
    assert.deepEqual(created.mcpServers[0].args, [SHIM]);
    assert.ok(h.agentLog().some((l: any) => l.kind === 'mcp' && l.ok === true));
  } finally {
    h.close();
  }
});

test('W: a token the Host did not issue is refused, and ending a session closes its connection', { timeout: 60_000 }, async () => {
  const tools = createHostTools({ register: (r: any) => r.register(echo) });
  const { mcp, sessions } = tools as any;
  try {
    const refused = spawn(process.execPath, [SHIM], {
      env: { ...process.env, SAGE_MCP_SOCKET: await mcp.socket.listen(), SAGE_MCP_TOKEN: 'nope' },
    });
    let err = '';
    refused.stderr.on('data', (c) => (err += c));
    assert.equal(await new Promise((r) => refused.once('close', r)), 1);
    assert.match(err, /refused/);

    // a session of this very process: the shim is started by it, so the kernel check passes
    const prepared = await mcp.prepare('k1', { harnessPid: process.pid });
    const entry = prepared.mcpServers[0];
    const env = Object.fromEntries(entry.env.map((e: any) => [e.name, e.value]));
    const shim = spawn(entry.command, entry.args, { env: { ...process.env, ...env } });
    const out: string[] = [];
    shim.stdout.on('data', (c) => out.push(String(c)));
    shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    // a Host session is tiered: an app tool waits behind app_more_tools and runs through its call (G10)
    await until(() => out.join('').includes('app_more_tools'));
    const call = { name: 'app_more_tools', arguments: { call: 'host_echo', arguments: { text: 'x' } } };
    shim.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: call })}\n`);
    await until(() => out.join('').includes('host-echo: x'));
    // the Host ends the session: the socket closes and sage-mcp exits cleanly
    sessions.end('k1');
    assert.equal(await new Promise((r) => shim.once('close', r)), 0);
  } finally {
    tools.close();
  }
});

test('B: a machine that cannot check its peers serves no tools, and status says so', { timeout: 60_000 }, () => {
  const none = createHostTools({ addon: null });
  assert.deepEqual([none.available, none.mcp, none.sessions, none.registry], [false, null, null, null]);
  assert.equal(none.close(), undefined);
  // a core without the peer routes can no more check a peer than none
  assert.equal(createHostTools({ addon: fakeCore({ 'caps.ancestry': [] }).addon }).available, false);
  assert.equal(createHostTools({ addon: fakeCore({ ...READY_ROUTES, 'caps.ready': false }).addon }).available, false);
  const blocked = hostStatus({ running: true, peerCheck: false }).isolation.blocked;
  assert.ok(blocked.some((l: string) => /the Rust core cannot run it here/.test(l)));
  const served = hostStatus({ running: true, peerCheck: true }).isolation;
  assert.ok(served.delivered.some((l: string) => /MoPilot tools for ACP, Claude Code and Codex chats/.test(l)));
  const tools = createHostTools();
  assert.ok(tools.available);
  tools.close();
});
