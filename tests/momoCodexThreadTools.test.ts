// #2356: a MoMo chat's Codex thread gets MoMo's tools and none of Codex's own file and shell tools, on every path its
// thread opens: MoMo's own start (ChatStarter), a resume after a restart, and a brain switch onto Codex. Codex lists a
// thread's MCP tools while it starts the thread, before its answer names the thread and before the chat is tagged
// MoMo's: the list it takes then is the one the model has. The real adapter, the real thread-config injection, the
// real registry and tool session over a fake app-server that lists the tools as Codex does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, settle, thread } from './support/codex-harness/fixture.ts';

const require = createRequire(import.meta.url);
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { answerToolRequest } = require('../electron/capabilities/mcp/socket.cjs');
const { ISOLATED_THREAD, FEATURES_OFF } = require('../electron/harness/codexIsolation.cjs');
const { isolateChatTools, momoListed } = require('../electron/momo/contract/toolIsolation.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');

const OWN = /^sage_[0-9a-f]{12}$/;
const ALL_OFF = Object.fromEntries(Object.keys(FEATURES_OFF).map((k) => [k, false]));

function rig() {
  let n = 0;
  // MoMo's chats, as the chats store tags them: only once the start returned
  const momo = new Set<string>();
  const chats = () => ({ records: new Map([...momo].map((id) => [id, { meta: { momo: 'main' } }])) });
  const registry = new Registry();
  const isMomoChat = isolateChatTools(registry, chats);
  // a MoMo tool (visibleTo, as memoryTools.cjs registers it), a browser tool MoMo may use, and a coding-side tool
  registry.register({ name: 'momo_memory_read', policy: 'observe', handler: () => ({}), visibleTo: momoListed(isMomoChat, () => true) });
  registry.register({ name: 'browser_navigate', policy: 'act', handler: () => ({}) });
  registry.register({ name: 'list_chats', policy: 'observe', handler: () => ({}) });
  const sessions = new ToolSessions();
  const opened: string[] = [];
  const open = sessions.open.bind(sessions);
  sessions.open = (key: string, o: any) => (opened.push(key), open(key, o));
  const tools = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => true,
    pluginConfig: () => ({}),
    nativeEnabled: () => true,
  });
  /** what the model gets: the session's tools as Codex lists them now */
  const listed: string[][] = [];
  const list = async () => {
    const s = sessions.get(opened.at(-1)!);
    const r = await answerToolRequest({ registry, session: s, calls: new Map(), msg: { id: 1, method: 'tools/list' } });
    listed.push(r.result.tools.map((t: any) => t.name).sort());
  };
  const ctx = setup(
    {
      // Codex starts the thread's MCP servers and lists their tools before it answers
      'thread/start': async () => (await list(), { thread: thread(`th-${++n}`) }),
      'thread/resume': async (p: any) => (await list(), { thread: thread(p.threadId) }),
    },
    { isolated: (chat: string) => momo.has(chat), tools },
  );
  ctx.a.chatOf = (id: string) => id;
  return { ...ctx, tools, momo, listed, list };
}

/** What a thread-opening request carried: MoPilot's server, and each of Codex's own tools' switches. */
function carried(params: any) {
  const config = params.config ?? {};
  const servers = Object.keys(config.mcp_servers ?? {});
  return {
    own: servers.some((s) => OWN.test(s) && config.mcp_servers[s].enabled !== false),
    off: Object.fromEntries(Object.keys(FEATURES_OFF).map((k) => [k, config.features?.[k]])),
  };
}
const MOMO_TOOLS = ['browser_navigate', 'momo_memory_read'];

test('#2356 repro: MoMo’s own start: from its first list the thread has MoMo’s tools, MoPilot’s server and every Codex tool off', async () => {
  const r = rig();
  const started = await r.a.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' });
  // ChatStarter tags the chat MoMo's once the start returns
  r.momo.add(started.thread.id);
  assert.deepEqual(carried(r.server.params('thread/start')[0]), { own: true, off: ALL_OFF });
  assert.deepEqual(r.listed, [MOMO_TOOLS]);
  // and after: the chat is named and tagged, and lists the same
  await r.list();
  assert.deepEqual(r.listed[1], MOMO_TOOLS);
});

test('#2356: a resume after a restart: the MoMo chat’s thread loads with the same', async () => {
  const r = rig();
  r.momo.add('momo-th');
  await r.a.ensureResumed('momo-th');
  await settle();
  assert.deepEqual(carried(r.server.params('thread/resume')[0]), { own: true, off: ALL_OFF });
  assert.deepEqual(r.listed, [MOMO_TOOLS]);
});

test('#2356: a brain switch onto Codex: the new thread lists MoMo’s tools and carries the same', async () => {
  const r = rig();
  r.momo.add('momo-chat');
  const runner = new SwitchRunner({
    prefs: () => ({ permission: 'default' }),
    permissionParams: () => ({}),
    claim: () => undefined,
    codex: { startThread: (p: any, o: any) => r.a.startThread(p, o) },
    isolated: (id: string) => r.momo.has(id),
  });
  await runner.startNative('momo-chat', 'codex', '/momo', 'gpt-5', []);
  assert.deepEqual(carried(r.server.params('thread/start')[0]), { own: true, off: ALL_OFF });
  assert.deepEqual(r.listed, [MOMO_TOOLS]);
});

test('#2356: a coding chat’s thread never lists MoMo’s tools, before or after its chat is known', async () => {
  const r = rig();
  await r.a.startThread({ cwd: '/w' });
  await r.list();
  // list_chats is an app tool, behind app_more_tools on a thread without Codex's own tool search (G10)
  assert.deepEqual(r.listed, [
    ['app_more_tools', 'browser_navigate'],
    ['app_more_tools', 'browser_navigate'],
  ]);
  assert.equal(carried(r.server.params('thread/start')[0]).off.shell_tool, undefined);
});

test('#2356: a MoMo thread’s waiting session lists MoMo’s tools only while MoMo is allowed; a known chat by its own rule', () => {
  const { pendingMomoChat } = require('../electron/momo/contract/toolIsolation.cjs');
  const { startOwner } = require('../electron/harness/codexIsolation.cjs');
  let allowed = true;
  const listed = momoListed(
    (id: string) => id === 'momo',
    () => allowed,
  );
  const pending = startOwner({ [ISOLATED_THREAD]: true }, 'codex:k').chatId;
  assert.equal(pending, pendingMomoChat('codex:k'));
  assert.deepEqual(startOwner({}, 'codex:k'), {});
  assert.equal(listed(pending), true);
  assert.equal(listed('momo'), true);
  assert.equal(listed('code'), false);
  allowed = false;
  assert.equal(listed(pending), false);
});
