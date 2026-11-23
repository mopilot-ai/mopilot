// MoMo's trust gate on every harness's tool channel (#2283): the gate is in the shared registry, so Claude Code's SDK MCP
// servers (sdkMcp.cjs), the sage-mcp socket that Codex's MCP config and ACP sessions connect to (socket.cjs, used by
// codexConfig.cjs and sessionMcp.cjs) and Codex's dynamic tool requests (serverRequests.cjs) each refuse a tainted
// MoMo chat's navigation and let an untainted one through, audited.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { auditLog } from './support/momo-trust.ts';

const require = createRequire(import.meta.url);
const z = require('zod');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { placement } = require('../electron/capabilities/contract/hostServers.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { codexServerRequests } = require('../electron/capabilities/contract/serverRequests.cjs');
const { Sentinel } = require('../electron/momo/sentinel.cjs');
const { createTrustGate } = require('../electron/momo/trustGate.cjs');
const { CURRENT } = require('../electron/momo/audit.cjs');
const { momoTool } = require('../electron/momo/contract/toolIsolation.cjs');
// a sentinel with no approval card: a decision that would ask is answered by nobody, so it doesn't run
const NO_CARD = async () => null;
const { createMomoCallGate, chatIdentity } = require('../electron/momo/toolTrust.cjs');

const SAGE = 'sage_aaaaaaaaaaaa';
const TAINTED = 'momo-tainted';
const CLEAN = 'momo-clean';
const PRIVATE_URL = 'https://httpbin.org/anything?rent=1800';

function rig(harness: string) {
  const momo = (id: string) => id === TAINTED || id === CLEAN;
  const records = new Map<string, any>(
    [TAINTED, CLEAN].map((id) => [id, { segments: [{ kind: harness }], meta: { momo: 'main', account: { id: 'work', pinned: false } } }]),
  );
  const registry = new Registry();
  registry.setChatScope(momoTool, momo);
  const sentinel = new Sentinel({ askUser: NO_CARD, allowed: () => true, sources: { files: { level: 'read', private: true } } });
  const t = auditLog();
  registry.setChatGate(
    createMomoCallGate({ trust: createTrustGate({ sentinel, audit: t.log }), sentinel, identity: chatIdentity(() => ({ records })) }),
  );
  const ran: string[] = [];
  for (const name of ['browser_navigate', 'chrome_navigate', 'computer_type'])
    registry.register({
      name,
      policy: 'act',
      authorizesItself: true,
      handler: async (a: any) => (ran.push(`${name} ${a.url ?? a.text}`), 'ok'),
    });
  const entries = () =>
    fs
      .readFileSync(path.join(t.dir, CURRENT), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {
    registry,
    ran,
    entries,
    taint: () => sentinel.decide({ chatId: TAINTED, tool: 'momo_files', source: 'files', kind: 'read' }),
  };
}

/** The tainted chat's calls never ran, the clean chat's did; each audited with the chat's harness. */
function check(r: ReturnType<typeof rig>, harness: string) {
  assert.deepEqual(r.ran, [`browser_navigate ${PRIVATE_URL}`, 'chrome_navigate https://example.com/', 'computer_type hello']);
  const byChat = (id: string) => r.entries().filter((e) => e.chatId === id);
  assert.deepEqual(
    byChat(TAINTED).map((e) => [e.kind, e.action, e.decision, e.harness, e.account]),
    ['browser_navigate', 'chrome_navigate', 'computer_type'].map((a) => ['refusal', a, 'no-answer', harness, 'work']),
  );
  assert.deepEqual(
    byChat(CLEAN).map((e) => [e.kind, e.action, e.harness]),
    ['browser_navigate', 'chrome_navigate', 'computer_type'].flatMap((a) => [
      ['intent', a, harness],
      ['outcome', a, harness],
    ]),
  );
}

const CALLS: [string, any][] = [
  ['browser_navigate', { url: PRIVATE_URL }],
  ['chrome_navigate', { url: 'https://example.com/' }],
  ['computer_type', { text: 'hello' }],
];

test('Claude Code: the SDK MCP servers refuse a tainted MoMo chat’s egress and run a clean one’s', async () => {
  const r = rig('claude');
  await r.taint();
  const servers = (chatId: string) =>
    sdkMcpServers({ sdk, z, registry: r.registry, serverName: SAGE, owner: { chatId, segmentId: 'seg' } });
  const clients = new Map<string, Client>();
  const client = async (chatId: string, server: string) => {
    const k = `${chatId} ${server}`;
    if (!clients.has(k)) {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await servers(chatId).get(server).instance.connect(a);
      const c = new Client({ name: 'test', version: '0' });
      await c.connect(b);
      clients.set(k, c);
    }
    return clients.get(k) as Client;
  };
  for (const chatId of [TAINTED, CLEAN])
    for (const [tool, args] of CALLS) {
      const p = placement(tool, SAGE);
      const res: any = await (await client(chatId, p.server)).callTool({ name: p.name, arguments: args });
      assert.equal(res.isError, chatId === TAINTED, `${chatId} ${tool}`);
    }
  for (const c of clients.values()) await c.close();
  check(r, 'claude');
});

const sockets: any[] = [];
after(() => sockets.forEach((s) => s.close()));

test('Codex MCP and ACP sessions: the sage-mcp socket refuses a tainted MoMo chat’s egress and runs a clean one’s', async () => {
  const r = rig('acp:opencode');
  await r.taint();
  const sessions = new ToolSessions();
  const s = new ToolSocket({ sessions, registry: r.registry, verifyPeer: async () => null });
  sockets.push(s);
  const file = await s.listen();
  for (const chatId of [TAINTED, CLEAN]) {
    const { token } = sessions.open(chatId, { harnessPid: 1, chatId, segmentId: 'seg' });
    const c = net.createConnection(file);
    c.setEncoding('utf8');
    let buf = '';
    const waiters: ((m: any) => void)[] = [];
    c.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiters.shift()?.(m);
      }
    });
    const ask = (m: any) => new Promise<any>((res) => (waiters.push(res), c.write(`${JSON.stringify(m)}\n`)));
    await ask({ id: 0, method: 'hello', params: { token, pid: 9 } });
    let id = 1;
    for (const [name, args] of CALLS) {
      const res = await ask({ id: id++, method: 'tools/call', params: { name, arguments: args } });
      assert.equal(res.result.isError, chatId === TAINTED, `${chatId} ${name}`);
    }
    c.destroy();
  }
  check(r, 'acp:opencode');
});

test('Codex dynamic tools: an item/tool/call request refuses a tainted MoMo chat’s egress and runs a clean one’s', async () => {
  const r = rig('codex');
  await r.taint();
  for (const chatId of [TAINTED, CLEAN])
    for (const [tool, args] of CALLS) {
      const reply: any = await new Promise((send) => {
        const handle = codexServerRequests({ registry: r.registry, send, owner: () => ({ chatId, segmentId: 'seg' }) });
        assert.equal(handle({ id: 'q', method: 'item/tool/call', params: { threadId: 't', tool, arguments: args } }), true);
      });
      assert.equal(reply.result.success, chatId === CLEAN, `${chatId} ${tool}`);
    }
  check(r, 'codex');
});
