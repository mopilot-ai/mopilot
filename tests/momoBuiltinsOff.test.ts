// A chat kept apart from the coding side (MoMo's, #2139) runs with the harness's own file and shell tools off, so MoMo
// reads files only through its own Files source: Claude Code without any of its own tools, Codex turns in
// its strictest sandbox (read-only, no network, never escalating), and an ACP agent's file and terminal requests refused.
// Other chats are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, settle } from './support/codex-harness/fixture.ts';

const require = createRequire(import.meta.url);
const { isolateOptions } = require('../electron/harness/claude/isolation.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { STRICTEST, ISOLATED_THREAD, FEATURES_OFF, isolateConfig, CodexIsolation } = require('../electron/harness/codexIsolation.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { AcpHost } = require('../electron/harness/acp.cjs');
const { guardIsolated } = require('../electron/harness/acp/clientMethods.cjs');

test('Claude Code: an isolated session has none of Claude Code’s own tools (an empty built-in set); other sessions keep them', async () => {
  const options: any = { disallowedTools: ['WebSearch', 'Bash'] };
  isolateOptions(options);
  assert.deepEqual(options.tools, []);
  // a list some caller passed stays as it was: the isolation adds none
  assert.deepEqual(options.disallowedTools, ['WebSearch', 'Bash']);
  const prepared = async (isolated: boolean) => {
    const o: any = {};
    await prepareSessionTools(
      { isolated: () => isolated },
      { takesPluginDirs: () => false },
      '/cli',
      o,
      {},
      { chatId: 'c' },
      'k',
      () => 'c',
    );
    return o;
  };
  assert.deepEqual((await prepared(true)).tools, []);
  assert.equal((await prepared(false)).tools, undefined);
});

test('Codex: every turn of an isolated chat runs read-only, offline and never escalating; other chats keep their sandbox', async () => {
  const { a, server } = setup({ 'review/start': () => ({}) }, { isolated: (chatId: string) => chatId === 'momo' });
  await a.startTurn('momo', { kind: 'codex', id: 'momo' }, { text: 'hi' });
  await a.startTurn('code', { kind: 'codex', id: 'code' }, { text: 'hi' });
  await a.request('review/start', { threadId: 'momo', target: {}, delivery: 'inline' });
  await settle();
  const [momo, code] = server.params('turn/start');
  assert.deepEqual(momo.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(momo.approvalPolicy, 'never');
  assert.deepEqual(STRICTEST, { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
  assert.notDeepEqual(code.sandboxPolicy, STRICTEST.sandboxPolicy);
  // a review carries no sandbox of its own: it is sent as asked, after the memory switch
  assert.deepEqual(server.params('review/start'), [{ threadId: 'momo', target: {}, delivery: 'inline' }]);
});

test('ACP: an isolated chat’s file and terminal requests are refused, through the host; others are served', async () => {
  const host = new AcpHost({
    items: {},
    quirks: () => ({ label: 'test' }),
    resolveBin: () => null,
    pty: { spawn: () => undefined, kill: () => undefined },
  });
  const agent = {};
  const momo = { key: 'acp:kimi:momo', sessionId: 's-momo', agent, cwd: '/w' };
  const code = { key: 'acp:kimi:code', sessionId: 's-code', agent, cwd: '/w' };
  for (const chat of [momo, code]) {
    host.chats.set(chat.key, chat);
    host.bindSession(chat, chat.sessionId);
  }
  (host as any).isolated = (chatId: string) => chatId === momo.key;
  for (const method of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/kill'])
    await assert.rejects(host.onAgentRequest(agent, method, { sessionId: 's-momo', path: '/etc/hosts' }), {
      code: -32000,
      message: "MoMo's chats don't read or write files or run commands here",
    });
  // another chat's file read goes through (it fails only because the file isn't there)
  await assert.rejects(
    host.onAgentRequest(agent, 'fs/read_text_file', { sessionId: 's-code', path: '/nowhere/at/all.txt' }),
    (e: any) => e.code !== -32000,
  );
  // the helper alone: other requests, no chat, or a host no one told about isolation pass
  assert.equal(guardIsolated({ isolated: () => true }, 'session/request_permission', momo), momo);
  assert.equal(guardIsolated({ isolated: () => true }, 'fs/read_text_file', null), null);
  assert.equal(guardIsolated({}, 'fs/read_text_file', momo), momo);
});

test('Codex: an isolated thread starts with its own shell, exec, image and sub-agent tools, every plugin and every MCP server but MoPilot’s off', () => {
  const config = {
    features: { goals: true },
    plugins: { 'tidy@mopilot-acme': { enabled: true } },
    mcp_servers: { sage_0123456789ab: { command: '/bin/sage-mcp' }, node_repl: { command: 'node' } },
  };
  assert.equal(isolateConfig({}, config), config);
  assert.equal(isolateConfig(null, config), config);
  const off = isolateConfig({ [ISOLATED_THREAD]: true }, config);
  assert.deepEqual(off.features, { goals: true, ...FEATURES_OFF });
  assert.deepEqual(FEATURES_OFF, {
    shell_tool: false,
    unified_exec: false,
    view_image: false,
    multi_agent: false,
    code_mode_host: false,
    // Codex memory off from the thread's first turn, before it can take a memory mode (#2276)
    memories: false,
    external_agent_memory_import: false,
    // no user hooks and no skill search: they bring the coding side's instructions in (#2308)
    hooks: false,
    skill_search: false,
    // no ChatGPT apps: their tools would run outside MoPilot's trust gate (#5824)
    apps: false,
  });
  // no skill list (~/.agents/skills included) and no AGENTS.md from the thread's folder (#2308)
  assert.equal(off.project_doc_max_bytes, 0);
  assert.deepEqual(off.skills, { include_instructions: false });
  assert.deepEqual(isolateConfig({ [ISOLATED_THREAD]: true }, { skills: { bundled: true } }).skills, {
    bundled: true,
    include_instructions: false,
  });
  assert.deepEqual(off.plugins, { 'tidy@mopilot-acme': { enabled: false }, 'unified-computer-use@openai-bundled': { enabled: false } });
  assert.deepEqual(off.mcp_servers, {
    sage_0123456789ab: { command: '/bin/sage-mcp' },
    node_repl: { command: 'node', enabled: false },
  });
  // a config with none of those parts
  assert.deepEqual(isolateConfig({ [ISOLATED_THREAD]: true }, {}).plugins, { 'unified-computer-use@openai-bundled': { enabled: false } });
});

test('Codex: the thread config goes out isolated, never native, with or without MoPilot’s tools; others as before', () => {
  const make = (o: any) =>
    new CodexToolInjection({
      sessions: new ToolSessions(),
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      pluginConfig: () => ({}),
      nativeEnabled: () => true,
      ...o,
    });
  for (const hasTools of [true, false]) {
    const inj = make({ hasTools: () => hasTools });
    inj.setUserServers(['rea']);
    const out = inj.outgoing({ id: 1, method: 'thread/start', params: { [ISOLATED_THREAD]: true, cwd: '/w' } });
    assert.equal(out.params.config.features.shell_tool, false, String(hasTools));
    // memory off by config from the first turn, on a start and on a resume or fork (#2276)
    for (const method of ['thread/resume', 'thread/fork']) {
      const again = inj.outgoing({ id: 3, method, params: { [ISOLATED_THREAD]: true, threadId: 't' } });
      assert.equal(again.params.config.features.memories, false, method);
      assert.equal(again.params.config.features.external_agent_memory_import, false, method);
    }
    assert.equal(out.params.config.features.memories, false);
    assert.equal(out.params.config.features.external_agent_memory_import, false);
    // MoMo's own Codex home defines none of the user's servers: an entry naming one is an invalid server there (#2330)
    assert.equal(out.params.config.mcp_servers?.rea, undefined);
    assert.equal(inj.isNativeThread('t'), false);
    // the symbol never reaches Codex
    assert.equal(JSON.stringify(out.params).includes('isolated'), false);
    // another thread on the same paths has its tools
    const plain = make({ hasTools: () => hasTools }).outgoing({ id: 2, method: 'thread/start', params: { cwd: '/w' } });
    assert.notEqual(plain.params.config?.features?.shell_tool, false);
    // a coding thread's memory is the user's, as Codex has it
    for (const method of ['thread/start', 'thread/resume']) {
      const coding = make({ hasTools: () => hasTools }).outgoing({ id: 4, method, params: { cwd: '/w', threadId: 'c' } });
      assert.equal(coding.params.config?.features?.memories, undefined, method);
      assert.equal(coding.params.config?.features?.external_agent_memory_import, undefined, method);
    }
    // a helper thread (a title) of an isolated chat is isolated too; a coding chat's helper is not (#2308)
    const helper = (params: any) =>
      make({ hasTools: () => hasTools }).outgoing({ id: 5, method: 'thread/start', params }, { helper: true });
    assert.equal(helper({ [ISOLATED_THREAD]: true, ephemeral: true }).params.config.features.memories, false);
    assert.equal(helper({ [ISOLATED_THREAD]: true, ephemeral: true }).params.config.skills.include_instructions, false);
    assert.equal(helper({ ephemeral: true }).params.config.features?.memories, undefined);
  }
});

test('Codex: a resumed or forked isolated thread is marked to load isolated again', async () => {
  const iso = new CodexIsolation({ isolated: () => true, chatOf: (t: string) => t, call: async () => ({}) });
  for (const method of ['thread/resume', 'thread/fork'])
    assert.equal((await iso.gate(method, { threadId: 't' }))[ISOLATED_THREAD], true, method);
  assert.equal((await iso.gate('thread/read', { threadId: 't' }))[ISOLATED_THREAD], undefined);
});

test('Codex: MoMo’s new thread and a switch’s new thread for an isolated chat start isolated; others don’t', async () => {
  const asked: any[] = [];
  const starter = new ChatStarter({
    prefs: () => ({}),
    codexThread: async (p: any) => (asked.push(p), { id: `th${asked.length}` }),
    claudeSession: () => undefined,
    acpSession: () => undefined,
    chats: { patchMeta: () => true },
    started: () => undefined,
  });
  await starter.startCodex('/w', null, { isolated: true });
  await starter.startCodex('/w', null);
  assert.deepEqual(asked, [{ cwd: '/w', isolated: true }, { cwd: '/w' }]);
  const started: any[] = [];
  const runner = (isolated?: (id: string) => boolean) =>
    new SwitchRunner({
      prefs: () => ({ permission: 'default' }),
      permissionParams: () => ({}),
      claim: () => undefined,
      codex: { startThread: async (p: any, o: any) => (started.push(p), o.onThread('th'), { thread: { id: 'th' } }) },
      ...(isolated ? { isolated } : {}),
    });
  await runner((id) => id === 'momo').startNative('momo', 'codex', '/w', 'gpt-5', []);
  await runner((id) => id === 'momo').startNative('code', 'codex', '/w', 'gpt-5', []);
  await runner().startNative('momo', 'codex', '/w', 'gpt-5', []);
  assert.deepEqual(
    started.map((p) => p[ISOLATED_THREAD] === true),
    [true, false, false],
  );
});
