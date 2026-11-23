// The segment a MoPilot tool call names is the key its chat records the segment by, on every harness
// (electron/platform/segmentOwner.cjs): a Claude Code session's calls named the bare session id while the chat records
// 'claude:<id>', so every tool that checks its caller (update_task_list, wrap_up, linked sessions, peer messages,
// scheduled tasks, plugin skills, the PR monitor) refused Claude Code chats with no_owner. The Claude tool channel,
// the ACP session tools, the Registry and the session tools are real; the SDK and the orchestrator are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSdk } from './support/control-matrix-kit.ts';

const require = createRequire(import.meta.url);
const { segmentKey, ownerOf } = require('../electron/platform/segmentOwner.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { registerSessionTools } = require('../electron/capabilities/tools/sessions.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { prepareSessionTools: prepareAcpTools } = require('../electron/harness/acpSessionTools.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { toRendererSegment } = require('../electron/platform/chats.cjs');

const records = new Map<string, any>([
  // a chat that switched from Codex to Claude Code keeps both segments
  [
    'chat-1',
    {
      segments: [
        { kind: 'codex', nativeId: 'th-0' },
        { kind: 'claude', nativeId: 'sess-1' },
      ],
    },
  ],
  ['chat-2', { segments: [{ kind: 'acp:test', nativeId: 'native-2' }] }],
]);

test('a segment key is the renderer’s: prefixed by its kind, except a bare Codex thread id', () => {
  assert.equal(segmentKey('claude', 'sess-1'), 'claude:sess-1');
  assert.equal(segmentKey('acp:test', 'native-2'), 'acp:test:native-2');
  assert.equal(segmentKey('codex', 'th-0'), 'th-0');
  for (const s of records.get('chat-1').segments) assert.equal(segmentKey(s.kind, s.nativeId), toRendererSegment(s).nativeId);
});

test('a chat owns a call only for a segment it records, any of them or with current only its last', () => {
  assert.equal(ownerOf(records, { chatId: 'chat-1', segmentId: 'claude:sess-1' }), 'chat-1');
  assert.equal(ownerOf(records, { chatId: 'chat-1', segmentId: 'th-0' }), 'chat-1');
  assert.equal(ownerOf(records, { chatId: 'chat-1', segmentId: 'th-0' }, { current: true }), null);
  assert.equal(ownerOf(records, { chatId: 'chat-1', segmentId: 'claude:sess-1' }, { current: true }), 'chat-1');
  // the bare id is not the Claude segment's key: no harness's id can pass for another's
  assert.equal(ownerOf(records, { chatId: 'chat-1', segmentId: 'sess-1' }), null);
  // another chat's segment, an unknown chat, no records
  assert.equal(ownerOf(records, { chatId: 'chat-1', segmentId: 'acp:test:native-2' }), null);
  assert.equal(ownerOf(records, { chatId: 'nope', segmentId: 'claude:sess-1' }), null);
  assert.equal(ownerOf(null, { chatId: 'chat-1', segmentId: 'claude:sess-1' }), null);
});

test('a Claude Code session’s update_task_list reaches its chat: the session names the segment its chat records', async () => {
  const registry = new Registry();
  const lists: [string, any][] = [];
  const orchestrator = { unavailable: null, taskList: (chatId: string, a: any) => (lists.push([chatId, a]), { steps: 1 }) };
  registerSessionTools(registry, { orchestrator, owner: (ctx: any) => ownerOf(records, ctx) });
  const sessions = new ToolSessions();
  const state: any = { sdk: async () => fakeSdk, sageTools: { registry, sessions, enabled: () => true } };
  const options: any = {};
  // as electron/harness/claude/adapter.cjs starts it: the session id bare, the process keyed by the renderer's key
  await prepareSessionTools(
    state,
    { takesPluginDirs: () => false },
    '/cli',
    options,
    {},
    { chatId: 'chat-1', sessionId: 'sess-1' },
    'claude:sess-1',
    () => 'chat-1',
  );
  const server: any = Object.values(options.mcpServers)[0];
  const tool = server.tools.find((t: any) => t.name === 'update_task_list');
  const items = [{ content: 'Step', status: 'in_progress' }];
  const result = await tool.handler({ items }, {});
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(lists, [['chat-1', { items }]]);
});

test('a Claude Code session started without a session id names its process key', async () => {
  const opened: any[] = [];
  const sessions = { open: (_key: string, owner: any) => (opened.push(owner), { serverName: 'sage_aaaaaaaaaaaa' }), end: () => {} };
  const state: any = { sdk: async () => fakeSdk, sageTools: { registry: new Registry(), sessions, enabled: () => true } };
  await prepareSessionTools(state, { takesPluginDirs: () => false }, '/cli', {}, {}, { chatId: 'chat-1' }, 'claude:sess-1', () => 'chat-1');
  assert.equal(opened[0].segmentId, 'claude:sess-1');
});

test('an ACP session names the segment its chat records', async () => {
  const prepared: any[] = [];
  const host = {
    tools: { prepare: async (_key: string, o: any) => (prepared.push(o), { serverName: 's', mcpServers: [] }) },
    assertChatCurrent: () => {},
    quirksOf: () => null,
    plugins: null,
  };
  await prepareAcpTools(host, { key: 'acp:test:native-2', chatId: 'chat-2', harness: 'test' }, { pid: 1, caps: {} }, null);
  assert.equal(ownerOf(records, { chatId: 'chat-2', segmentId: prepared[0].segmentId }), 'chat-2');
});

test('a Codex thread’s session names the segment its chat records', () => {
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => true,
  });
  const sent = inj.outgoing({ id: 1, method: 'thread/start', params: { cwd: '/w' } });
  const [server] = Object.values(sent.params.config.mcp_servers) as any[];
  inj.observe({ id: 1, result: { thread: { id: 'th-0' } } });
  const live = sessions.resolve(server.env.SAGE_MCP_TOKEN);
  assert.equal(ownerOf(records, { chatId: 'chat-1', segmentId: live.segmentId }), 'chat-1');
});
