// Work package 2.9: a chat's tools follow its owner Host's capabilities. Fixed when each channel's session starts (Claude Code's in-process servers, Codex's sage-mcp thread config, ACP's session/new), identical on all three; a call that arrives anyway is refused as capability_missing; a change applies from the next turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as sdk from '@anthropic-ai/claude-agent-sdk';

const require = createRequire(import.meta.url);
const z = require('zod');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { toolNeeds } = require('../electron/capabilities/contract/hostScope.cjs');
const { answerToolRequest } = require('../electron/capabilities/mcp/socket.cjs');
const { injectSdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { shownTools } = require('../electron/capabilities/contract/surfaceNote.cjs');

const SAGE = 'sage_aaaaaaaaaaaa';
const TOOLS = ['list_chats', 'desktop_screenshot', 'chrome_tabs', 'browser_open'];
const LINUX = { iab: false, cu: false, desktop: false, bu: false, shell: true };
const MAC = { iab: true, cu: true, desktop: true, bu: true, shell: true };

function world(caps: Record<string, Record<string, boolean> | null>) {
  const registry = new Registry();
  for (const name of TOOLS) registry.register({ name, policy: 'observe', handler: async () => 'x' });
  registry.setHostScope((chatId: string) => caps[chatId]);
  return { registry, scope: registry.hostScope, caps };
}

const listed = async (registry: any, session: any) =>
  (await answerToolRequest({ registry, session, calls: new Map(), msg: { id: 1, method: 'tools/list' } })).result.tools
    .map((t: any) => t.name)
    .sort();

const CHANNELS = {
  claude: async (registry: any, chatId: string) => {
    const out = injectSdkMcpServers({ allowedTools: [] }, { sdk, z, registry, serverName: SAGE, owner: { chatId, segmentId: chatId } });
    // the host servers present browser_/desktop_ under short names, so the count of tools presented is compared
    return out.tools.size;
  },
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
    inj.outgoing({ id: 7, method: 'thread/start', params: { cwd: '/w' } });
    const { key } = inj.pending.get(7);
    inj.observe({ id: 7, result: { thread: { id: chatId } } });
    return listed(registry, sessions.get(key));
  },
  acp: async (registry: any, chatId: string) => {
    const sessions = new ToolSessions();
    const mcp = new SessionMcp({ sessions, socket: { on: () => undefined, listen: async () => '/tmp/s.sock' }, command: '/bin/sage-mcp' });
    await mcp.prepare(chatId, { harnessPid: 1, chatId });
    return listed(registry, sessions.get(chatId));
  },
};

test('toolNeeds: desktop needs the Host’s own desktop, Chrome needs bu, the browser needs iab, everything else needs nothing', () => {
  assert.equal(toolNeeds('desktop_screenshot'), 'desktop');
  assert.equal(toolNeeds('chrome_tabs'), 'bu');
  assert.equal(toolNeeds('browser_open'), 'iab');
  assert.equal(toolNeeds('list_chats'), null);
});

test('B4: on a Linux Host no family lists desktop_*, chrome_* or browser_* tools; a Mac Host lists them all', async () => {
  for (const [family, list] of Object.entries(CHANNELS)) {
    const { registry } = world({ [`${family}-linux`]: LINUX, [`${family}-mac`]: MAC });
    if (family === 'claude') {
      assert.equal(await list(registry, `${family}-linux`), 1, 'only list_chats is presented');
      assert.ok((await list(registry, `${family}-mac`)) > 1);
      continue;
    }
    // both are tiered here: list_chats waits behind app_more_tools (G10)
    assert.deepEqual(await list(registry, `${family}-linux`), ['app_more_tools'], family);
    // every surface is there, tiered: desktop_screenshot and list_chats wait behind their more tools (G10)
    assert.deepEqual(
      await list(registry, `${family}-mac`),
      ['app_more_tools', 'browser_open', 'chrome_tabs', 'desktop_more_tools'],
      family,
    );
  }
});

test('a chat with no remote owner (or no chat at all) keeps every tool', () => {
  const { registry } = world({ local: null });
  assert.equal(registry.list({ chatId: 'local' }).length, TOOLS.length);
  assert.equal(registry.list({ chatId: 'unknown' }).length, TOOLS.length);
  assert.equal(registry.list().length, TOOLS.length);
});

test('A/W: the list is kept for the turn; a Host change shows from the next turn, and Stop also ends the turn', async () => {
  const { registry, scope, caps } = world({ c1: MAC });
  assert.equal(registry.list({ chatId: 'c1' }).length, TOOLS.length);
  caps.c1 = LINUX;
  assert.equal(registry.list({ chatId: 'c1' }).length, TOOLS.length, 'same turn: unchanged');
  scope.thaw('c1');
  assert.deepEqual(
    registry.list({ chatId: 'c1' }).map((t: any) => t.name),
    ['list_chats'],
  );
  caps.c1 = MAC;
  registry.abortChat('c1');
  assert.equal(registry.list({ chatId: 'c1' }).length, TOOLS.length, 'Stop thawed it');
});

test('I: a call to a tool the Host lacks is refused as capability_missing and never runs', async () => {
  const { registry } = world({ c1: LINUX });
  let ran = false;
  registry.register({ name: 'desktop_click', policy: 'observe', handler: async () => ((ran = true), 'x') });
  const res = await registry.invoke('c1', 's1', 'desktop_click', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'capability_missing');
  assert.equal(ran, false);
  assert.equal((await registry.invoke('c1', 's1', 'list_chats', {})).ok, true);
});

test('the older computer_* tools act on this Mac, so a chat on a Host that lacks computer use is never offered them and a call is refused', async () => {
  const registry = new Registry();
  registry.register({ name: 'computer_click', policy: 'observe', handler: async () => 'x' });
  const caps: Record<string, Record<string, boolean> | null> = { onLinux: LINUX, onMac: MAC, onThisMac: null };
  registry.setHostScope((chatId: string) => caps[chatId]);
  const listedFor = (chat: string) => registry.list({ chatId: chat }).map((t: any) => t.name);
  assert.deepEqual(listedFor('onLinux'), []);
  assert.deepEqual(listedFor('onMac'), ['computer_click']);
  assert.deepEqual(listedFor('onThisMac'), ['computer_click'], 'a chat on this Mac has it');
  const refused = await registry.invoke('onLinux', 's1', 'computer_click', {});
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'capability_missing');
  assert.equal(toolNeeds('computer_click'), 'cu');
});

test('a chat on a Host: the Host’s own desktop serves desktop_*; a Host too old to say desktop, or that only says cu, serves none', () => {
  const registry = new Registry();
  registry.register({ name: 'desktop_click', policy: 'observe', handler: async () => 'x' });
  const caps: Record<string, Record<string, boolean> | null> = {
    withDesktop: MAC,
    oldHost: { iab: true, bu: true, shell: true },
    cuOnly: { iab: true, cu: true, desktop: false, bu: true, shell: true },
    onThisMac: null,
  };
  registry.setHostScope((chatId: string) => caps[chatId]);
  const listedFor = (chat: string) => registry.list({ chatId: chat }).map((t: any) => t.name);
  assert.deepEqual(listedFor('withDesktop'), ['desktop_click']);
  assert.deepEqual(listedFor('oldHost'), []);
  assert.deepEqual(listedFor('cuOnly'), []);
  assert.deepEqual(listedFor('onThisMac'), ['desktop_click']);
});

test('B: an unreadable Host serves nothing it did not declare', () => {
  const registry = new Registry();
  for (const name of TOOLS) registry.register({ name, policy: 'observe', handler: async () => 'x' });
  registry.setHostScope(() => {
    throw new Error('registry unreadable');
  });
  assert.deepEqual(
    registry.list({ chatId: 'c1' }).map((t: any) => t.name),
    ['list_chats'],
  );
});

test('Codex notes list the tools of the chat’s own Host', () => {
  const { registry } = world({ c1: LINUX });
  const visible = (chatId: string) => registry.list({ chatId }).map((t: any) => t.name);
  assert.deepEqual(shownTools(visible, null, 'c1'), ['list_chats']);
  assert.equal(shownTools(visible, null).length, TOOLS.length);
});

test('setHostScope(null) removes the rule', () => {
  const { registry } = world({ c1: LINUX });
  registry.setHostScope(null);
  assert.equal(registry.list({ chatId: 'c1' }).length, TOOLS.length);
});

test('a tool’s own needs overrides the name rule, both ways', async () => {
  const { registry } = world({ c1: LINUX });
  registry.register({ name: 'browser_neutral', policy: 'observe', needs: null, handler: async () => 'x' });
  registry.register({ name: 'remote_screen', policy: 'observe', needs: 'cu', handler: async () => 'x' });
  const names = registry.list({ chatId: 'c1' }).map((t: any) => t.name);
  assert.ok(names.includes('browser_neutral'));
  assert.ok(!names.includes('remote_screen'));
});

test('an unreadable read is not kept: the next read sees the Host', () => {
  let broken = true;
  const registry = new Registry();
  registry.register({ name: 'desktop_x', policy: 'observe', handler: async () => 'x' });
  registry.setHostScope(() => {
    if (broken) throw new Error('down');
    return MAC;
  });
  assert.equal(registry.list({ chatId: 'c1' }).length, 0);
  broken = false;
  assert.equal(registry.list({ chatId: 'c1' }).length, 1);
});
