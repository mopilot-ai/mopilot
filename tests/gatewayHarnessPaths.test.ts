// The gateway's tools on each harness's real channel and approval path (#2999 C2, I5): Claude Code's session (prepareSessionTools) presents them on MoPilot's own server and its canUseTool lets them through without a second card (autoAllow), with a byte-identical prefix for two sessions (B8); Codex's thread config approves MoPilot's server's tools and its sage channel lists and runs them; an ACP agent's permission request for one is MoPilot's own call (isSageToolCall), answered without a card. The only card is the gateway's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gatewayWorld, fakeServer, tick, READ, stdio } from './support/gatewayWorld.ts';

const require = createRequire(import.meta.url);
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { autoAllow } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { codexThreadConfig } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { answerToolRequest } = require('../electron/capabilities/mcp/socket.cjs');
const { requestPermission } = require('../electron/harness/acp/permission.cjs');

const add = { name: 'add', description: 'Add.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
const list = { name: 'list', description: 'List.', inputSchema: READ, annotations: { readOnlyHint: true } };
const settled = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

const recordingSdk = {
  tool: (name: string, description: string, schema: any, handler: Function) => ({ name, description, schema, handler }),
  createSdkMcpServer: ({ name, tools, instructions }: any) => ({ name, tools, instructions }),
};

async function world() {
  const w = gatewayWorld({ servers: { notes: fakeServer([add, list]) } });
  await w.gateway.add(stdio('notes'));
  await settled();
  return w;
}

async function claudeSession(w: any, sessions: any, chatId: string, sessionId: string) {
  const state: any = { sdk: async () => recordingSdk, sageTools: { registry: w.registry, sessions, enabled: () => true } };
  const options: any = {};
  const s: any = {};
  await prepareSessionTools(
    state,
    { takesPluginDirs: () => false },
    '/cli',
    options,
    s,
    { chatId, sessionId },
    `claude:${sessionId}`,
    () => chatId,
  );
  return { options, s };
}

test('Claude Code: gateway tools are on MoPilot’s server, canUseTool allows them with no harness card, the prefix is stable', async () => {
  const w = await world();
  const sessions = new ToolSessions();
  const a = await claudeSession(w, sessions, 'chat-1', 'sess-1');
  const b = await claudeSession(w, sessions, 'chat-2', 'sess-2');
  const [server] = Object.keys(a.options.mcpServers);
  const presented = a.options.mcpServers[server].tools.map((t: any) => t.name);
  for (const name of w.names()) {
    assert.ok(presented.includes(name), `${name} is presented on ${server}`);
    const full = `mcp__${server}__${name}`;
    assert.ok(a.s.sageTools.has(full), full);
    assert.deepEqual(autoAllow(a.s.sageTools, full, { text: 'x' }), { behavior: 'allow', updatedInput: { text: 'x' } });
  }
  const prefix = (o: any) =>
    JSON.stringify(
      Object.entries(o.mcpServers).map(([k, s]: any) => [k, s.instructions, s.tools.map((t: any) => [t.name, t.description, t.schema])]),
    );
  assert.equal(prefix(a.options), prefix(b.options));
  // the call goes through the Registry, where the gateway's own card asks
  const t = a.options.mcpServers[server].tools.find((x: any) => x.name.endsWith('_add'));
  await t.handler({ text: 'hi' }, {});
  assert.equal(w.s.cards.length, 1);
  assert.equal(w.s.cards[0].chatId, 'chat-1');
});

test('Codex: MoPilot’s server is approved by its thread config, and its sage channel lists and runs gateway tools', async () => {
  const w = await world();
  const sessions = new ToolSessions();
  const { serverName, key } = sessions.open('codex:t1', { chatId: 'chat-1', segmentId: 'seg-1' });
  const cfg = codexThreadConfig({ serverName, command: 'sage-mcp', socketPath: '/s', token: 't' });
  assert.equal(cfg.mcp_servers[serverName].default_tools_approval_mode, 'approve');
  // the gateway's card plus its call fit inside Codex's tool timeout
  const { ASK_MS, CALL_MS, IDLE_MS } = require('../electron/gateway/offer.cjs');
  // the SDK checks the total only when progress comes, so a call can last CALL_MS + IDLE_MS
  assert.ok((ASK_MS + CALL_MS + IDLE_MS) / 1000 < cfg.mcp_servers[serverName].tool_timeout_sec);
  const s = sessions.get(key);
  const listed = await answerToolRequest({ registry: w.registry, session: s, calls: new Map(), msg: { id: 1, method: 'tools/list' } });
  const names = listed.result.tools.map((t: any) => t.name);
  for (const n of w.names()) assert.ok(names.includes(n), n);
  const called = await answerToolRequest({
    registry: w.registry,
    session: s,
    calls: new Map(),
    msg: { id: 2, method: 'tools/call', params: { name: w.names().find((n: string) => n.endsWith('_list')), arguments: {} } },
  });
  assert.equal(called.result.isError, false);
  // tiered (no tool search): one group per server behind mcp_more_tools
  const tiered = sessions.open('codex:t2', { chatId: 'chat-1', segmentId: 'seg-1', tiered: true });
  const t2 = await answerToolRequest({
    registry: w.registry,
    session: sessions.get(tiered.key),
    calls: new Map(),
    msg: { id: 3, method: 'tools/list' },
  });
  const tieredNames = t2.result.tools.map((t: any) => t.name);
  assert.ok(tieredNames.includes('mcp_more_tools'));
  assert.ok(!tieredNames.some((n: string) => n.startsWith('mcp_notes_')));
});

test('ACP: a permission request for a gateway tool on the chat’s own server is MoPilot’s call, allowed with no card', async () => {
  const w = await world();
  const sessions = new ToolSessions();
  const { serverName } = sessions.open('acp:c1', { chatId: 'chat-1', segmentId: 'seg-1' });
  const options = [
    { optionId: 'once', kind: 'allow_once' },
    { optionId: 'no', kind: 'reject_once' },
  ];
  const host: any = { unattended: () => assert.fail('no card'), items: {}, permSeq: 0 };
  const chat: any = { serverName, prompting: true, key: 'c1' };
  for (const name of w.names())
    for (const title of [`mcp__${serverName}__${name}`, `${serverName}/${name}`, `${name} (${serverName} MCP Server)`]) {
      const r = await requestPermission(host, chat, { options, toolCall: { title, kind: 'other' } });
      assert.deepEqual(r, { outcome: { outcome: 'selected', optionId: 'once' } }, title);
    }
});
