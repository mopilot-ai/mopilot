// What a MoMo background chat's harness is shown is decided by the chat's tag alone (#2299), on every tool channel: a
// harness may list its tools once, when its session connects, and keep that list (opencode caches each MCP server's
// tools at connect, whatever list_changed sage-mcp passes on later), so a list taken before a routine's run begins, while it runs or after
// it ends is the same. Claude Code (the in-process SDK servers), Codex (sage-mcp on the thread's config) and ACP (sage-mcp
// in session/new) each list MoMo's main chat's momo_routine_propose and a routine run's memory tools at the moment their
// session starts; a run is never offered the removed Feed's or Topics' tools.
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
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ISOLATED_THREAD } = require('../electron/harness/codexIsolation.cjs');
const { isolateChatTools } = require('../electron/momo/contract/toolIsolation.cjs');
const { registerRoutineTools } = require('../electron/momo/routineTools.cjs');
const { registerMemoryTools } = require('../electron/momo/memoryTools.cjs');
const { registerWriteTools } = require('../electron/momo/sources/writeTools.cjs');
const { isMomoMeta } = require('../shared/momoChat.mjs');

const SAGE = 'sage_aaaaaaaaaaaa';
/** Each MoMo chat's role: its tag, the tool its work needs and the one it never gets. */
const ROLES = [
  { tag: { momo: 'main' }, needs: 'momo_routine_propose', never: 'momo_feed_post' },
  { tag: { momo: 'routine', routineId: 'momo.r-1' }, needs: 'momo_memory_search', never: 'momo_routine_propose' },
] as const;

function world() {
  const records = new Map<string, any>();
  const meta = (id: string) => records.get(id)?.meta;
  const registry = new Registry();
  registry.register({ name: 'list_chats', policy: 'observe', handler: async () => 'x' });
  isolateChatTools(registry, () => ({ records }));
  const isMomoChat = (id: string) => isMomoMeta(meta(id));
  const allowed = () => true;
  registerRoutineTools(registry, { routines: {}, allowed, chatMeta: meta, connected: () => [], changed: () => undefined });
  registerMemoryTools(registry, { store: {}, allowed, isMomoChat });
  registerWriteTools(registry, { writer: {} as any, allowed, isMomoChat });
  return { registry, records };
}

const listed = async (registry: any, session: any) =>
  (await answerToolRequest({ registry, session, calls: new Map(), msg: { id: 1, method: 'tools/list' } })).result.tools
    .map((t: any) => t.name)
    .sort();

/** What each family's harness is shown when its session starts, for chat `chatId`. */
const CHANNELS = {
  // the in-process servers a Claude Code session is given when it starts (its first message)
  claude: async (registry: any, chatId: string) => {
    const out = injectSdkMcpServers({ allowedTools: [] }, { sdk, z, registry, serverName: SAGE, owner: { chatId, segmentId: chatId } });
    return [...out.tools].map((n: string) => n.replace(`mcp__${SAGE}__`, '')).sort();
  },
  // sage-mcp on an isolated thread's config: the session names the thread's chat once the thread exists
  codex: async (registry: any, chatId: string) => {
    const sessions = new ToolSessions();
    const inj = new CodexToolInjection({
      sessions,
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      pluginConfig: () => ({}),
      nativeEnabled: () => false,
      hasTools: () => true,
    });
    inj.outgoing({ id: 7, method: 'thread/start', params: { [ISOLATED_THREAD]: true, cwd: '/w' } });
    const { key } = inj.pending.get(7);
    inj.observe({ id: 7, result: { thread: { id: chatId } } });
    return listed(registry, sessions.get(key));
  },
  // sage-mcp in session/new: the session is the chat's own from the start
  acp: async (registry: any, chatId: string) => {
    const sessions = new ToolSessions();
    const mcp = new SessionMcp({ sessions, socket: { on: () => undefined, listen: async () => '/tmp/s.sock' }, command: '/bin/sage-mcp' });
    await mcp.prepare(chatId, { harnessPid: 1, chatId });
    return listed(registry, sessions.get(chatId));
  },
};

test('every family: each MoMo chat is shown the tool its work needs when its session starts, before anything begins', async () => {
  for (const [family, list] of Object.entries(CHANNELS)) {
    const { registry, records } = world();
    for (const [i, role] of ROLES.entries()) {
      const chatId = `${family}-chat-${i}`;
      records.set(chatId, { meta: role.tag });
      const names = await list(registry, chatId);
      assert.ok(names.includes(role.needs), `${family}: ${role.needs} for ${JSON.stringify(role.tag)}`);
      assert.ok(!names.includes(role.never), `${family}: no ${role.never} for ${JSON.stringify(role.tag)}`);
      assert.ok(!names.includes('list_chats'), `${family}: a MoMo chat never gets the chat tools`);
      assert.ok(!names.some((n: string) => /^momo_(feed|topic)_/.test(n)), `${family}: no Feed or Topics tool`);
    }
    const coding = await list(registry, `${family}-coding`);
    assert.ok(!coding.includes('momo_routine_propose'), `${family}: a coding chat never sees it`);
  }
});

test('every family, ACP included: MoMo’s main chat is shown the Calendar and Reminders write tools through the registry, a coding chat never is', async () => {
  const WRITES = ['momo_calendar_create_event', 'momo_reminders_add', 'momo_reminders_complete', 'momo_undo_write'];
  for (const [family, list] of Object.entries(CHANNELS)) {
    const { registry, records } = world();
    records.set(`${family}-main`, { meta: ROLES[0].tag });
    const names = await list(registry, `${family}-main`);
    for (const tool of WRITES) assert.ok(names.includes(tool), `${family}: ${tool}`);
    const coding = await list(registry, `${family}-coding`);
    for (const tool of WRITES) assert.ok(!coding.includes(tool), `${family}: a coding chat never sees ${tool}`);
  }
});

test('a chat’s list is the same whenever its harness takes it: before its run begins, while a message is written to it, after it ends', async () => {
  for (const [family, list] of Object.entries(CHANNELS)) {
    const { registry, records } = world();
    const chatId = `${family}-run`;
    records.set(chatId, { meta: ROLES[1].tag });
    const before = await list(registry, chatId);
    // its meta changes as a run goes (a message MoMo wrote, a harness switch): the tag alone decides the list
    records.set(chatId, { meta: { ...ROLES[1].tag, authored: { m1: { by: 'momo', title: 'x' } }, unread: true } });
    assert.deepEqual(await list(registry, chatId), before, `${family}: running`);
    records.set(chatId, { meta: { ...ROLES[1].tag, archived: true } });
    assert.deepEqual(await list(registry, chatId), before, `${family}: ended`);
  }
});
