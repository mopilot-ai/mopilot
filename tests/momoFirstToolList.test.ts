// A MoMo chat's very first tool list has none of the chat tools (#2139), on every harness family: a Claude Code or ACP
// chat is tagged by ChatStarter before its harness session starts (the session starts at the first message), and a Codex
// thread, which starts before its chat can be tagged (the chat id is the thread's), starts with the session's own rule
// keeping MoMo's tools only (momoHide, from the isolated thread/start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

const require = createRequire(import.meta.url);
const z = require('zod');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { answerToolRequest } = require('../electron/capabilities/mcp/socket.cjs');
const { injectSdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ISOLATED_THREAD, DATA_ONLY_THREAD } = require('../electron/harness/codexIsolation.cjs');
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
const { isolateChatTools, momoHide } = require('../electron/momo/contract/toolIsolation.cjs');

const SAGE = 'sage_aaaaaaaaaaaa';
const NAMES = ['list_chats', 'read_chat', 'send_message_to_chat', 'show_pane', 'brand_new_tool'];

function world() {
  const records = new Map<string, any>();
  const steps: string[] = [];
  const chats = {
    records,
    patchMeta: (id: string, patch: any) => {
      steps.push(`tag ${id.split(':')[0]}`);
      records.set(id, { segments: [], meta: { ...records.get(id)?.meta, ...patch } });
      return true;
    },
  };
  const registry = new Registry();
  for (const name of NAMES)
    registry.register({ name, policy: 'observe', handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  isolateChatTools(registry, () => chats);
  const starter = new ChatStarter({
    prefs: () => ({}),
    codexThread: async () => ({ id: 'th-momo' }),
    claudeSession: (id: string) => steps.push(`session ${id.split(':')[0]}`),
    acpSession: (id: string) => steps.push(`session ${id.split(':')[0]}`),
    chats,
    changed: () => undefined,
    started: () => steps.push('announced'),
  });
  return { registry, starter, steps };
}

const listed = async (registry: any, session: any) =>
  (await answerToolRequest({ registry, session, calls: new Map(), msg: { id: 1, method: 'tools/list' } })).result.tools.map(
    (t: any) => t.name,
  );

test('Claude Code and ACP: the chat is tagged before its session can start, so its first tool list is MoMo’s tools only', async () => {
  const { registry, starter, steps } = world();
  const claude = starter.startClaude('/w', null, { meta: { momo: 'main' } });
  const acp = starter.startAcp('kimi', '/w', null, { meta: { momo: 'main' } });
  // the session is only registered here; it starts at the first message, which comes after the chat is tagged
  assert.deepEqual(steps, ['session claude', 'tag claude', 'announced', 'session acp', 'tag acp', 'announced']);
  // Claude Code: the in-process servers its first query is given (sdkMcp.cjs)
  const out = injectSdkMcpServers(
    { allowedTools: [] },
    { sdk, z, registry, serverName: SAGE, owner: { chatId: claude, segmentId: claude } },
  );
  assert.deepEqual([...out.tools], [`mcp__${SAGE}__show_pane`]);
  // an ACP agent's sage-mcp session is the chat's own (session chatId = the chat key)
  assert.deepEqual(await listed(registry, { chatId: acp, segmentId: acp, hide: null }), ['show_pane']);
  // a coding chat started the same way keeps them all
  const code = starter.startClaude('/w', null);
  assert.deepEqual(await listed(registry, { chatId: code, segmentId: code, hide: null }), NAMES);
});

test('Codex: an isolated thread’s first tool list and calls are MoMo’s tools only, before its chat is tagged', async () => {
  const { registry } = world();
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    pluginConfig: () => ({}),
    nativeEnabled: () => true,
    hasTools: () => true,
  });
  const start = (id: number, params: any) => {
    inj.outgoing({ id, method: 'thread/start', params });
    return sessions.get(inj.pending.get(id).key);
  };
  const momo = start(1, { [ISOLATED_THREAD]: true, cwd: '/w' });
  // no chat names this session yet: the registry's chat scope can't see it is MoMo's, the session's own rule does
  assert.equal(registry.isApart(momo.chatId), false);
  // show_pane is MoMo's, deferred behind app_more_tools on a thread without a tool search (G10); app_more_tools runs only MoMo's
  assert.deepEqual(await listed(registry, momo), ['app_more_tools']);
  const call = await answerToolRequest({
    registry,
    session: momo,
    calls: new Map(),
    msg: { id: 2, method: 'tools/call', params: { name: 'list_chats', arguments: {} } },
  });
  assert.equal(call.result.isError, true);
  // a coding thread keeps them all, behind app_more_tools on a thread without a tool search (G10)
  const coding = start(3, { cwd: '/w' });
  assert.deepEqual(await listed(registry, coding), ['app_more_tools']);
  const more = await answerToolRequest({
    registry,
    session: coding,
    calls: new Map(),
    msg: { id: 4, method: 'tools/call', params: { name: 'app_more_tools', arguments: {} } },
  });
  for (const n of NAMES) assert.match(more.result.content[0].text, new RegExp(`- ${n}: `), n);
});

test('MoMo’s memory pass: its first tool list is empty on every harness, and every call is refused', async () => {
  const { registry, starter } = world();
  const claude = starter.startClaude('/w', null, { meta: { momo: 'memory' } });
  const acp = starter.startAcp('kimi', '/w', null, { meta: { momo: 'memory' } });
  const out = injectSdkMcpServers(
    { allowedTools: [] },
    { sdk, z, registry, serverName: SAGE, owner: { chatId: claude, segmentId: claude } },
  );
  assert.deepEqual([...(out.tools ?? [])], [], 'Claude Code');
  assert.deepEqual(await listed(registry, { chatId: acp, segmentId: acp, hide: null }), [], 'ACP');
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    pluginConfig: () => ({}),
    nativeEnabled: () => true,
    hasTools: () => true,
  });
  inj.outgoing({ id: 1, method: 'thread/start', params: { [ISOLATED_THREAD]: true, [DATA_ONLY_THREAD]: true, cwd: '/w' } });
  const codex = sessions.get(inj.pending.get(1).key);
  assert.deepEqual(await listed(registry, codex), [], 'Codex, before its chat is tagged');
  for (const session of [codex, { chatId: acp, segmentId: acp, hide: null }]) {
    const call = await answerToolRequest({
      registry,
      session,
      calls: new Map(),
      msg: { id: 2, method: 'tools/call', params: { name: 'show_pane', arguments: {} } },
    });
    assert.equal(call.result.isError, true);
  }
});

test('the session rule keeps the session’s own rule on top: a MoMo tool it hides stays hidden', () => {
  assert.equal(momoHide(null)('show_pane'), false);
  assert.equal(momoHide(null)('list_chats'), true);
  const native = momoHide((name: string) => name === 'browser_navigate');
  assert.equal(native('browser_navigate'), true);
  assert.equal(native('browser_click'), false);
  assert.equal(native('read_chat'), true);
});
