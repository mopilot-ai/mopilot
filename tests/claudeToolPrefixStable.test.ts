// Claude Code sessions share the prompt cache (#2579): tool definitions open the cached prompt prefix, so two sessions
// started with the same options must present byte-identical MCP servers (names, tool names, descriptions, schemas,
// instructions). A random sage_<nonce> per CLI process made every new process re-write the whole ~49k-token prefix.
// The shared name is new at every app start and never saved: the model and the transcripts see it, so one that outlived
// the run could be declared by a repository's .mcp.json, which the CLI lets shadow our server of that name, and its tools
// would match the allow rules. Each in-process server still runs its calls as its own chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions, SERVER_NAME } = require('../electron/capabilities/contract/session.cjs');
const { registerSessionTools } = require('../electron/capabilities/tools/sessions.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');

/** An SDK whose servers keep everything the CLI would send the model about them. */
const recordingSdk = {
  tool: (name: string, description: string, schema: any, handler: Function) => ({ name, description, schema, handler }),
  createSdkMcpServer: ({ name, tools, instructions }: any) => ({ name, tools, instructions }),
};

/** What a session's servers put into the prompt, as one comparable string. */
const prefixOf = (options: any) =>
  JSON.stringify(
    Object.entries(options.mcpServers).map(([key, s]: [string, any]) => ({
      key,
      name: s.name,
      instructions: s.instructions ?? null,
      tools: s.tools.map((t: any) => ({ name: t.name, description: t.description, schema: t.schema })),
    })),
  );

function world() {
  const registry = new Registry();
  const lists: [string, any][] = [];
  const orchestrator = { unavailable: null, taskList: (chatId: string, a: any) => (lists.push([chatId, a]), { steps: 1 }) };
  registerSessionTools(registry, { orchestrator, owner: (ctx: any) => ctx.chatId });
  const sessions = new ToolSessions();
  const state: any = { sdk: async () => recordingSdk, sageTools: { registry, sessions, enabled: () => true } };
  return { state, sessions, lists };
}

async function start(state: any, chatId: string, sessionId: string) {
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

test('two Claude Code sessions present the same tool prefix, so the second reads the first one’s prompt cache', async () => {
  const { state } = world();
  const a = await start(state, 'chat-1', 'sess-1');
  const b = await start(state, 'chat-2', 'sess-2');
  assert.ok(Object.keys(a.options.mcpServers).length > 0);
  assert.equal(prefixOf(a.options), prefixOf(b.options));
  // a restarted process (an idle CLI reaped, then resumed) keeps it too
  const again = await start(state, 'chat-1', 'sess-1');
  assert.equal(prefixOf(again.options), prefixOf(a.options));
});

test('the shared name is new for each app run, and each session’s calls stay its own chat’s', async () => {
  const one = world();
  const other = world();
  const a = await start(one.state, 'chat-1', 'sess-1');
  const b = await start(one.state, 'chat-2', 'sess-2');
  const [name] = Object.keys(a.options.mcpServers);
  assert.match(name, SERVER_NAME);
  // another run of the app (another ToolSessions) picks another name: nothing written before it starts can declare it
  const [otherName] = Object.keys((await start(other.state, 'chat-1', 'sess-1')).options.mcpServers);
  assert.notEqual(otherName, name);
  // same name, but each in-process server runs as its own chat
  const call = (o: any, items: any) =>
    o.options.mcpServers[name].tools.find((t: any) => t.name === 'update_task_list').handler({ items }, {});
  await call(b, [{ content: 'B', status: 'in_progress' }]);
  await call(a, [{ content: 'A', status: 'in_progress' }]);
  assert.deepEqual(
    one.lists.map(([chat, x]) => [chat, x.items[0].content]),
    [
      ['chat-2', 'B'],
      ['chat-1', 'A'],
    ],
  );
});

test('a shared name ends with no session: ending one session leaves the other’s token working', () => {
  const sessions = new ToolSessions();
  const a = sessions.open('claude:a', { shared: 'claude' });
  const b = sessions.open('claude:b', { shared: 'claude' });
  assert.equal(a.serverName, b.serverName);
  sessions.end('claude:a');
  assert.equal(sessions.resolve(a.token), null);
  assert.equal(sessions.resolve(b.token)?.key, 'claude:b');
  // a session that doesn't share (a Codex thread, an ACP session) still gets a name of its own
  const own = sessions.open('codex:t', {});
  assert.notEqual(own.serverName, a.serverName);
  assert.match(own.serverName, SERVER_NAME);
  // scopes don't share with each other
  assert.notEqual(sessions.open('x', { shared: 'other' }).serverName, a.serverName);
});

const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');

test('every Codex thread presents one server name, so their tools open the same cached prompt prefix (#2579); each keeps its own token', () => {
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 100,
    hasTools: () => true,
  });
  const serverOf = (msg: any) => {
    const [name] = Object.keys(msg.params.config.mcp_servers);
    return { name, token: msg.params.config.mcp_servers[name].env.SAGE_MCP_TOKEN };
  };
  const a = serverOf(inj.outgoing({ id: 1, method: 'thread/start', params: {} }));
  const b = serverOf(inj.outgoing({ id: 2, method: 'thread/start', params: {} }));
  // a thread the app-server loads from disk, which this run never started
  const c = serverOf(inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'th-old' } }));
  assert.equal(a.name, b.name);
  assert.equal(a.name, c.name);
  assert.equal(new Set([a.token, b.token, c.token]).size, 3);
  inj.observe({ id: 1, result: { thread: { id: 'th-a' } } });
  inj.observe({ id: 2, result: { thread: { id: 'th-b' } } });
  assert.equal(sessions.resolve(a.token).segmentId, 'th-a');
  assert.equal(sessions.resolve(b.token).segmentId, 'th-b');
});
