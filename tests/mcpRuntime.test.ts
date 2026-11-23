// Desktop MCP runtime selection preserves native launches and gives Linux Codex/ACP the same authenticated portable bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fakeCore, READY_ROUTES } from './support/fake-core.ts';

const require = createRequire(import.meta.url);
const { mcpRuntime } = require('../electron/capabilities/mcp/runtime.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { SessionMcp, sageMcpEnv } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');

test('Linux packages start the Rust sage-mcp beside their core, with no Node and no JS bridge, independently of macOS helpers', () => {
  const bridge = path.join('/resources', 'core', 'sage-mcp');
  const files = new Set([bridge, '/resources/node/bin/node', '/resources/sage-mcp/bin/sage-mcp.mjs']);
  const runtime = (addon: any = fakeCore(READY_ROUTES).addon) =>
    mcpRuntime({
      platform: 'linux',
      packaged: true,
      resourcesPath: '/resources',
      addon,
      exists: (file: string) => files.has(file),
      which: () => assert.fail('packaged tools never use PATH'),
    });
  assert.deepEqual(runtime(), { command: bridge, args: [], available: true });
  // without the core's peer check every hello would be refused: the tools are reported missing
  assert.equal(runtime(null).available, false);
  files.delete(bridge);
  assert.equal(runtime().available, false, 'a Node and a JS bridge left in resources are not a bridge');
});

test('a Linux checkout finds real Node on the login PATH and never falls back to Electron as Node', () => {
  assert.deepEqual(mcpRuntime({ platform: 'linux', root: '/repo', which: () => '/bin/node', exists: () => true }), {
    command: '/bin/node',
    args: ['/repo/host/bin/sage-mcp.mjs'],
    available: true,
  });
  for (const which of [undefined, () => null]) {
    const runtime = mcpRuntime({ platform: 'linux', root: '/repo', which, exists: () => assert.fail('missing Node is not a file') });
    assert.equal(runtime.available, false);
    assert.equal(runtime.command, '');
  }
});

test('macOS retains its native executable and reports a missing bridge accurately', () => {
  assert.deepEqual(mcpRuntime({ platform: 'darwin', packaged: true, resourcesPath: '/App/Contents/Resources', exists: () => true }), {
    command: '/App/Contents/Helpers/sage-mcp',
    args: [],
    available: true,
  });
  assert.deepEqual(mcpRuntime({ platform: 'darwin', root: '/repo', exists: () => false }), {
    command: '/repo/native/sage-mcp/build/sage-mcp',
    args: [],
    available: false,
  });
});

test('Linux and macOS advertise no tools when the core cannot check who connects', () => {
  const noCore = { root: '/repo', which: () => '/bin/node', exists: () => true };
  for (const addon of [null, fakeCore({ 'caps.ancestry': [] }).addon, fakeCore({ ...READY_ROUTES, 'caps.ready': false }).addon]) {
    assert.equal(mcpRuntime({ ...noCore, platform: 'linux', addon }).available, false);
    assert.equal(mcpRuntime({ ...noCore, platform: 'darwin', addon }).available, false);
  }
  const ready = fakeCore(READY_ROUTES).addon;
  assert.equal(mcpRuntime({ ...noCore, platform: 'linux', addon: ready }).available, true);
  assert.equal(mcpRuntime({ ...noCore, platform: 'darwin', addon: ready }).available, true);
});

test('Windows selects its compiled bridge and requires the peer check before advertising tools', () => {
  for (const packaged of [false, true]) {
    const command = packaged ? path.join('/resources', 'core', 'sage-mcp.exe') : path.join('/repo', 'core/target/release/sage-mcp.exe');
    let present = true;
    let ready = 'false';
    const runtime = (addon: any = { routes: () => [], dispatchSync: () => Buffer.from(ready) }) =>
      mcpRuntime({
        platform: 'win32',
        packaged,
        resourcesPath: '/resources',
        root: '/repo',
        addon,
        exists: (file: string) => file === command && present,
        which: () => assert.fail('Windows uses its native bridge'),
      });
    assert.deepEqual(runtime(null), { command, args: [], available: false });
    assert.equal(runtime().available, false);
    ready = 'true';
    assert.deepEqual(runtime(), { command, args: [], available: true });
    present = false;
    assert.equal(runtime({ routes: () => assert.fail('a missing bridge cannot serve tools') }).available, false);
    present = true;
    assert.equal(runtime().available, true, 'a restored bridge is detected without a stale cache');
  }
});

test('a present Windows executable is unavailable without the native ancestry prerequisite on every host platform', () => {
  for (const addon of [null, { routes: () => [] }]) {
    assert.equal(mcpRuntime({ platform: 'win32', root: '/repo', exists: () => true, addon }).available, false);
  }
});

test('Windows Codex and ACP keep the selected executable, literal argv, socket/token and SystemRoot', async (t) => {
  const beforePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const beforeRoot = process.env.SystemRoot;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.SystemRoot = 'D:\\Windows root';
  t.after(() => {
    Object.defineProperty(process, 'platform', beforePlatform);
    if (beforeRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = beforeRoot;
  });
  const addon = fakeCore(READY_ROUTES).addon;
  const transport = mcpRuntime({ platform: 'win32', root: '/repo', exists: () => true, addon });
  assert.equal(transport.available, true);
  const sessions = new ToolSessions();
  const injection = new CodexToolInjection({ sessions, ...transport, socketPath: '127.0.0.1:53211', harnessPid: () => 42 });
  for (const [index, method] of ['thread/start', 'thread/fork', 'thread/resume'].entries()) {
    const message = injection.outgoing({ id: index + 1, method, params: { threadId: `win-${index}` } });
    const server = (Object.values(message.params.config.mcp_servers) as any[])[0];
    assert.equal(server.command, transport.command);
    assert.deepEqual(server.args, []);
    assert.equal(server.env.SystemRoot, 'D:\\Windows root');
    assert.equal(server.env.SAGE_MCP_SOCKET, '127.0.0.1:53211');
    assert.equal(sessions.resolve(server.env.SAGE_MCP_TOKEN).harnessPid, 42);
  }
  const socket = Object.assign(new EventEmitter(), { listen: async () => '127.0.0.1:53211' });
  const acp = new SessionMcp({ sessions, socket, ...transport });
  const prepared = await acp.prepare('acp:registry:windows', { harnessPid: 43, chatId: 'stable-win-chat', segmentId: 'win-segment' });
  const server = prepared.mcpServers[0];
  assert.equal(server.command, transport.command);
  assert.deepEqual(server.args, []);
  const env = Object.fromEntries(server.env.map(({ name, value }: any) => [name, value]));
  assert.equal(env.SystemRoot, 'D:\\Windows root');
  assert.equal(env.SAGE_MCP_SOCKET, '127.0.0.1:53211');
  assert.equal(sessions.resolve(env.SAGE_MCP_TOKEN).chatId, 'stable-win-chat');
  acp.end('acp:registry:windows');
  injection.exited();
});

test('Codex start/fork/resume and ACP use the same portable runtime with isolated session credentials', async () => {
  const transport = mcpRuntime({ platform: 'linux', packaged: true, resourcesPath: '/resources', exists: () => true });
  const sessions = new ToolSessions();
  const injection = new CodexToolInjection({ sessions, ...transport, socketPath: '/tools.sock', harnessPid: () => 42 });
  const tokens = new Set();
  for (const [index, method] of ['thread/start', 'thread/fork', 'thread/resume'].entries()) {
    const message = injection.outgoing({ id: index + 1, method, params: { threadId: `thread-${index}` } });
    const servers = Object.values(message.params.config.mcp_servers) as any[];
    assert.equal(servers.length, 1);
    assert.equal(servers[0].command, transport.command);
    assert.deepEqual(servers[0].args, transport.args);
    assert.equal(servers[0].env.SAGE_MCP_SOCKET, '/tools.sock');
    assert.ok(servers[0].env.SAGE_MCP_TOKEN);
    tokens.add(servers[0].env.SAGE_MCP_TOKEN);
  }
  const socket = Object.assign(new EventEmitter(), { listen: async () => '/tools.sock' });
  const acp = new SessionMcp({ sessions, socket, ...transport });
  const prepared = await acp.prepare('acp:agent:session', { harnessPid: 43, chatId: 'stable-chat', segmentId: 'acp-segment' });
  assert.equal(prepared.mcpServers[0].command, transport.command);
  assert.deepEqual(prepared.mcpServers[0].args, transport.args);
  const token = prepared.mcpServers[0].env.find((pair: any) => pair.name === 'SAGE_MCP_TOKEN').value;
  assert.equal(tokens.has(token), false);
  socket.emit('connected', { key: 'acp:agent:session' });
  assert.equal(await acp.admission('acp:agent:session'), true);
  acp.end('acp:agent:session');
  assert.equal(await acp.admission('acp:agent:session'), false);
});

for (const native of [false, true]) {
  test(`issued Codex runtime preserves literal argv and session rotation with native=${native}`, () => {
    const sessions = new ToolSessions();
    const args = ['/resources with spaces/bridge.mjs', '--literal=$(echo unused)'];
    const injection = new CodexToolInjection({
      sessions,
      command: '/resources with spaces/node',
      args,
      socketPath: '/tools with spaces.sock',
      harnessPid: () => 42,
      nativeEnabled: () => native,
    });
    injection.setUserServers(['node_repl']);
    args.push('must not enter the copied launch arguments');
    let id = 1;
    for (const method of ['thread/start', 'thread/fork', 'thread/resume']) {
      const threadId = `thread-${id}`;
      const outgoing = (method: string) => injection.outgoing({ id: id++, method, params: { threadId } });
      const config = outgoing(method).params.config;
      const name = Object.keys(config.mcp_servers).find((key) => key.startsWith('sage_'))!;
      const server = config.mcp_servers[name];
      assert.deepEqual(server, {
        command: '/resources with spaces/node',
        args: ['/resources with spaces/bridge.mjs', '--literal=$(echo unused)'],
        env: sageMcpEnv({ socketPath: '/tools with spaces.sock', token: server.env.SAGE_MCP_TOKEN }),
        default_tools_approval_mode: 'approve',
        tool_timeout_sec: 900,
      });
      assert.equal(sessions.resolve(server.env.SAGE_MCP_TOKEN).harnessPid, 42);
      assert.deepEqual(config.mcp_servers.node_repl, { enabled: false });
      assert.equal(config.plugins['unified-computer-use@openai-bundled'].enabled, native);
      injection.observe({ id: id - 1, result: { thread: { id: threadId } } });
      assert.deepEqual(outgoing('thread/resume').params.config, config);
      injection.observe({ method: 'thread/closed', params: { threadId } });
      const rotated = outgoing('thread/resume').params.config.mcp_servers[name];
      assert.deepEqual(rotated.args, server.args);
      assert.notEqual(rotated.env.SAGE_MCP_TOKEN, server.env.SAGE_MCP_TOKEN);
      assert.equal(sessions.resolve(server.env.SAGE_MCP_TOKEN), null);
      assert.equal(sessions.resolve(rotated.env.SAGE_MCP_TOKEN).harnessPid, 42);
    }
    injection.exited();
  });
}
