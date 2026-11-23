// G11 (#3571): the user's Chrome's core tools load up front only while Chrome is the user's chosen browser, on every
// harness: Claude's alwaysLoad (toolLoading.cjs, sdkMcp.cjs, harness/claude/sessionTools.cjs) and a tiered session's
// preloaded chrome group (toolTiers.cjs, ToolSessions). A chat in the built-in browser carried ~2.5k tokens of a second
// browser's schemas on every request; the tools stay one ToolSearch or one browser_more_tools call away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, tiers, textOf, ToolSessions, answerToolRequest } from './support/tool-tiers-kit.ts';

const { preloadedFor } = createRequire(import.meta.url)('../electron/capabilities/mcp/socket.cjs');

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { isCoreTool, CORE_HOST } = require('../electron/capabilities/mcp/toolLoading.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');

const SAGE = 'sage_aaaaaaaaaaaa';
const sdk = {
  tool: (name: string, _d: string, _s: unknown, _h: unknown, options: any) => ({ name, options }),
  createSdkMcpServer: (options: any) => options,
};
const z = { fromJSONSchema: (schema: unknown) => schema };

/** A registry with one built-in browser tool and two of the user's Chrome's (one core, one not). */
function registry() {
  const r = new Registry();
  for (const name of ['browser_navigate', 'chrome_navigate', 'chrome_gif_creator'])
    r.register({ name, description: name, schema: { type: 'object', properties: {} }, policy: 'observe', handler: async () => 'ok' });
  return r;
}

/** server/tool -> alwaysLoad, for the servers a session gets. */
const loadsOf = (servers: Map<string, any>) =>
  Object.fromEntries([...servers].flatMap(([server, c]) => c.tools.map((t: any) => [`${server}/${t.name}`, t.options.alwaysLoad])));

test('isCoreTool: the mopilot_chrome core loads up front only with chromeCore; other servers ignore it', () => {
  for (const name of CORE_HOST.mopilot_chrome) {
    assert.equal(isCoreTool('mopilot_chrome', name, true), false, name);
    assert.equal(isCoreTool('mopilot_chrome', name, true, true), true, name);
  }
  assert.equal(isCoreTool('mopilot_chrome', 'gif_creator', true, true), false);
  assert.equal(isCoreTool('mopilot_browser', 'navigate', true, false), true);
  assert.equal(isCoreTool(SAGE, 'sage_debug_echo', false, false), true);
});

test('sdkMcpServers: Chrome not chosen defers its whole server; chosen loads its core, and the built-in browser is unchanged', () => {
  const r = registry();
  const off = loadsOf(sdkMcpServers({ sdk, z, registry: r, serverName: SAGE, owner: { chatId: 'c', segmentId: 's' } }));
  assert.deepEqual(off, {
    'mopilot_browser/navigate': true,
    'mopilot_chrome/navigate': false,
    'mopilot_chrome/gif_creator': false,
  });
  const on = loadsOf(sdkMcpServers({ sdk, z, registry: r, serverName: SAGE, owner: { chatId: 'c', segmentId: 's' }, chromeCore: true }));
  assert.deepEqual(on, { ...off, 'mopilot_chrome/navigate': true });
});

test("prepareSessionTools: a Claude session's Chrome core follows the user's browser choice, and the note says the same", async () => {
  const start = async (yourChrome: (() => boolean | 'preferred') | undefined) => {
    const sessions = new ToolSessions();
    const state: any = { sdk: async () => sdk, sageTools: { registry: registry(), sessions, enabled: () => true, yourChrome } };
    const options: any = {};
    await prepareSessionTools(
      state,
      { takesPluginDirs: () => false },
      '/cli',
      options,
      {},
      { chatId: 'c', sessionId: 's1' },
      'claude:s1',
      () => 'c',
    );
    const chrome = options.mcpServers.mopilot_chrome.tools.find((t: any) => t.name === 'navigate');
    return chrome.options.alwaysLoad;
  };
  assert.equal(await start(undefined), false, 'no browser control: nothing says Chrome is chosen');
  assert.equal(await start(() => false), false);
  assert.equal(await start(() => 'preferred'), true);
  assert.equal(await start(() => true), true);
});

test('ToolSessions: a session opened while Chrome is chosen lists the Chrome core group for its life; none by default', () => {
  const plain = new ToolSessions();
  plain.open('k', { tiered: true });
  assert.deepEqual([...plain.get('k').loaded], []);
  let chosen = false;
  const sessions = new ToolSessions({ preloaded: () => tiers.preloadedGroups(chosen) });
  sessions.open('off', { tiered: true });
  sessions.loadGroups('off', ['browser/tabs']);
  chosen = true;
  // a change of browser mid-session changes neither what it lists nor what it may call (no list_changed is sent)
  assert.deepEqual([...sessions.get('off').loaded], []);
  assert.deepEqual([...sessions.get('off').callable], ['browser/tabs']);
  sessions.open('on', { tiered: true });
  chosen = false;
  assert.deepEqual([...sessions.get('on').loaded], ['browser/chrome']);
  assert.deepEqual([...sessions.get('on').callable], ['browser/chrome']);
  // resuming keeps it; a new session (a switch's new segment) starts from the choice at that time
  sessions.rotate('on');
  assert.deepEqual([...sessions.get('on').loaded], ['browser/chrome']);
  sessions.open('on', { tiered: true });
  assert.deepEqual([...sessions.get('on').loaded], []);
});

test('a tiered session: Chrome not chosen lists none of its tools and points a direct call at the chrome group; chosen lists its core', async () => {
  const w = world();
  w.sessions.open('k', { chatId: 'c', segmentId: 's', tiered: true });
  const names = await w.list('k');
  for (const t of tiers.SURFACES.browser.groups.chrome.tools) assert.equal(names.includes(t), false, t);
  assert.ok(names.includes('browser_navigate') && names.includes('browser_more_tools'));
  const refused = await w.call('k', 'chrome_navigate', { url: 'https://example.com' });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.structuredContent.loadWith, { tool: 'browser_more_tools', arguments: { load: ['chrome'] } });
  // one call away: run now through the more tool
  const ran = await w.call('k', 'browser_more_tools', { call: 'chrome_navigate', arguments: { url: 'https://example.com' } });
  assert.equal(textOf(ran), 'ran chrome_navigate');

  const chosen = new ToolSessions({ preloaded: () => tiers.preloadedGroups(true) });
  chosen.open('k', { chatId: 'c', segmentId: 's', tiered: true });
  const ask = (method: string, params: any = {}) =>
    answerToolRequest({
      registry: w.registry,
      sessions: chosen,
      session: chosen.get('k'),
      calls: new Map(),
      msg: { id: 1, method, params },
    }) as any;
  const listed = (await ask('tools/list')).result.tools.map((t: any) => t.name);
  for (const t of tiers.SURFACES.browser.groups.chrome.tools) assert.ok(listed.includes(t), t);
  assert.equal(listed.includes('chrome_gif_creator'), false, 'the rest of Chrome stays in its groups');
  assert.equal(
    textOf((await ask('tools/call', { name: 'chrome_navigate', arguments: { url: 'https://example.com' } })).result),
    'ran chrome_navigate',
  );
});

test("preloadedFor: the app's sessions preload the Chrome core from BrowserControl's choice when each opens", () => {
  const live: any = {};
  const sessions = new ToolSessions({ preloaded: preloadedFor(live) });
  sessions.open('none', { tiered: true });
  live.browserControl = { userChrome: () => false };
  sessions.open('builtin', { tiered: true });
  live.browserControl = { userChrome: () => 'preferred' };
  sessions.open('chrome', { tiered: true });
  assert.deepEqual([...sessions.get('none').loaded], []);
  assert.deepEqual([...sessions.get('builtin').loaded], []);
  assert.deepEqual([...sessions.get('chrome').loaded], ['browser/chrome']);
});
