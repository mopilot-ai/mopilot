// The control matrix (docs/control-plane/matrix.md), stream Z: a Codex chat MoPilot serves the user's Chrome to reaches it
// only through MoPilot's chrome_* tools (#1319 G28, option A). The native thread's config leaves the Browser plugin's
// Chrome family out (its own cua_repl without the Chrome backends, the Chrome plugin off), the thread is shown the chrome_*
// tools and told so, its controller plan names MoPilot's Chrome, and the plugin's own Chrome stays only when the user
// keeps the vendor's (codex.browser.chromeExtension off) or MoPilot's chrome_* tools are off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/capabilities/', 'electron/platform/flags.cjs', 'shared/'];

const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const {
  cuaWithoutChrome,
  codexChromeOff,
  routedSurfaces,
  pluginChromeOffConfig,
  chromeToolsNote,
  CHROME_PLUGIN,
} = require('../electron/capabilities/channels/codexPluginChrome.cjs');
const { pluginCuaServer, pluginBrowserEnv } = require('../electron/capabilities/browser/iabBackend/environment.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { nativeThreadConfig } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { mainChromeBackends } = require('../electron/capabilities/browser/chromeBackend.cjs');

const flags =
  (over: Record<string, boolean> = {}) =>
  (k: string) =>
    over[k] ?? DEFAULTS[k] ?? false;

/** The plugin's cua_repl as its materialized .mcp.json defines it (26.1013). */
const PLUGIN_CUA = Object.freeze({
  command: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node',
  args: ['/x/cua-repl.mjs'],
  enabled: true,
  enabled_tools: ['js', 'js_reset', 'turn_ended'],
  env_vars: [],
  omit_tools_from: ['code_mode', 'deferred'],
  startup_timeout_sec: 120,
  tools: { js: { output_token_limit: 25000 } },
  env: {
    BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab,mcpapps',
    CUA_REPL_ENABLED_SURFACES: 'browser,computer',
    NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: 'Control the Chrome browser…',
    NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: 'Control the in-app browser…',
  },
});

test("CM-Z33: the plugin's cua_repl without its Chrome family is the plugin's own definition, with only the Chrome backends and instructions left out", () => {
  const cua = cuaWithoutChrome(PLUGIN_CUA);
  assert.equal(cua.env.BROWSER_USE_AVAILABLE_BACKENDS, 'iab,mcpapps');
  assert.equal(cua.env.NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME, undefined);
  assert.equal(cua.env.NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER, 'Control the in-app browser…');
  assert.equal(cua.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer', 'computer use and the in-app browser stay');
  for (const k of ['command', 'args', 'enabled_tools', 'env_vars', 'omit_tools_from', 'startup_timeout_sec', 'tools'])
    assert.deepEqual(cua[k], PLUGIN_CUA[k], k);
  assert.equal(cua.enabled, true);
  // the plugin's older name for its Chrome backend goes too; a list it doesn't set stays unset
  assert.equal(
    cuaWithoutChrome({ ...PLUGIN_CUA, env: { BROWSER_USE_AVAILABLE_BACKENDS: ' extension , iab' } }).env.BROWSER_USE_AVAILABLE_BACKENDS,
    'iab',
  );
  assert.equal(cuaWithoutChrome({ command: '/n', env: {} }).env.BROWSER_USE_AVAILABLE_BACKENDS, undefined);
  // nothing to start from: the plugin keeps its Chrome
  for (const bad of [null, undefined, {}, { command: 1, env: {} }, { command: '/n' }, { command: '/n', env: 'x' }])
    assert.equal(cuaWithoutChrome(bad), null);
  // the config fragment: the user-level cua_repl replaces the plugin's of the same name, and the Chrome plugin is off
  assert.deepEqual(pluginChromeOffConfig(cua), { mcp_servers: { cua_repl: cua }, plugins: { [CHROME_PLUGIN]: { enabled: false } } });
  assert.equal(CHROME_PLUGIN, 'chrome@openai-bundled');
  const config = nativeThreadConfig({ userServers: ['node_repl'], cua });
  assert.deepEqual(config.mcp_servers, { node_repl: { enabled: false }, cua_repl: cua });
  assert.deepEqual(config.plugins, { 'unified-computer-use@openai-bundled': { enabled: true }, [CHROME_PLUGIN]: { enabled: false } });
  assert.deepEqual(nativeThreadConfig().plugins, { 'unified-computer-use@openai-bundled': { enabled: true } });
});

test("CM-Z33: the plugin's Chrome is left out while MoPilot serves the user's Chrome to Codex through the chrome_* tools; with either off, Codex keeps it", () => {
  let reads = 0;
  const server = () => (reads++, PLUGIN_CUA);
  const shipped = { shipped: true, server };
  // the defaults where the build ships the extension: left out
  assert.equal(codexChromeOff({ isEnabled: flags(), ...shipped }).env.BROWSER_USE_AVAILABLE_BACKENDS, 'iab,mcpapps');
  // the vendor's own Chrome kept as Codex's (option B), MoPilot's chrome_* tools off, or no extension in this build
  assert.equal(codexChromeOff({ isEnabled: flags({ 'codex.browser.chromeExtension': false }), ...shipped }), null);
  assert.equal(codexChromeOff({ isEnabled: flags({ 'shared.browser.chromeExtensionByDefault': false }), ...shipped }), null);
  assert.equal(codexChromeOff({ isEnabled: flags(), shipped: false, server }), null);
  assert.equal(reads, 1, "the plugin's definition is read only when it is needed");
  // the plugin not installed: nothing to leave out
  assert.equal(codexChromeOff({ isEnabled: flags(), shipped: true, server: () => null }), null);
  // the surfaces a thread loads with: Chrome is MoPilot's only where the plugin could have served it
  let asked = 0;
  const off = () => (asked++, cuaWithoutChrome(PLUGIN_CUA));
  assert.deepEqual(routedSurfaces({ chrome: false, computer: true }, off), { surfaces: { chrome: false, computer: true }, cua: null });
  assert.equal(asked, 0);
  const routed = routedSurfaces({ chrome: true, computer: true }, off);
  assert.deepEqual(routed.surfaces, { chrome: false, computer: true });
  assert.equal(routed.cua.env.BROWSER_USE_AVAILABLE_BACKENDS, 'iab,mcpapps');
  assert.deepEqual(
    routedSurfaces({ chrome: true, computer: false }, () => null),
    { surfaces: { chrome: true, computer: false }, cua: null },
  );
});

test("CM-Z33: the plugin's cua_repl is read from the newest materialized version that defines one", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
  const put = (v: string, body: string) => {
    fs.mkdirSync(path.join(dir, v), { recursive: true });
    fs.writeFileSync(path.join(dir, v, '.mcp.json'), body);
  };
  assert.equal(pluginCuaServer({ codexHome: home }), null, 'no plugin');
  put('26.900.1', JSON.stringify({ mcpServers: { cua_repl: PLUGIN_CUA } }));
  put('26.1013.2', '{ not json');
  put('26.1013.3', 'null');
  put('26.1013.4', JSON.stringify({ other: 1 }));
  put('26.1013.10', JSON.stringify({ mcpServers: { cua_repl: { command: '/n' } } }));
  assert.deepEqual(pluginCuaServer({ codexHome: home }), PLUGIN_CUA);
  assert.deepEqual(pluginBrowserEnv({ codexHome: home }).backends, ['chrome', 'iab', 'mcpapps']);
  put('26.1100.1', JSON.stringify({ mcpServers: { cua_repl: { command: '/m', env: { BROWSER_USE_CODEX_APP_VERSION: '26.1100.1' } } } }));
  assert.deepEqual(pluginBrowserEnv({ codexHome: home }), { backends: [], flavor: null, version: '26.1100.1' });
});

/** A native Codex thread loaded through the real injection, with the plugin able to serve Chrome and computer use. */
function inject(o: { chromeOff?: () => any; tools?: string[]; hasTools?: boolean } = {}) {
  const hides: any[] = [];
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => o.hasTools !== false,
    nativeEnabled: () => true,
    nativeSurfaces: () => ({ chrome: true, computer: true }),
    nativeHideFor: (surfaces: any) => (hides.push(surfaces), (n: string) => surfaces.chrome && n.startsWith('chrome_')),
    visibleTools: () => o.tools ?? ['browser_navigate', 'chrome_navigate', 'chrome_tabs_context_mcp'],
    chromeInstances: () => ({ chrome: ['ext-1'], codexApp: [] }),
    ...(o.chromeOff ? { chromeOff: o.chromeOff } : {}),
  });
  const sent = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  inj.observe({ id: 1, result: { thread: { id: 'th' } } });
  return { inj, sent, hides };
}

test("CM-Z33: a native Codex thread MoPilot serves Chrome to loads without the plugin's Chrome, is shown the chrome_* tools and told they are its Chrome", () => {
  const cua = cuaWithoutChrome(PLUGIN_CUA);
  const { inj, sent, hides } = inject({ chromeOff: () => cua });
  const config = sent.params.config;
  assert.deepEqual(config.mcp_servers.cua_repl, cua);
  assert.equal(config.plugins[CHROME_PLUGIN].enabled, false);
  assert.equal(config.plugins['unified-computer-use@openai-bundled'].enabled, true, 'computer use and the in-app browser stay');
  assert.ok(
    Object.keys(config.mcp_servers).some((k) => k.startsWith('sage')),
    "MoPilot's own tools are there",
  );
  // the plugin serves computer use only: the thread's sage-mcp keeps the chrome_* tools, and its path says so
  assert.deepEqual(hides, [{ chrome: false, computer: true }]);
  assert.deepEqual(inj.loadedPath('th'), { chrome: false, computer: true, iab: false, tools: true });
  assert.deepEqual(inj.routedSurfaces().surfaces, { chrome: false, computer: true }, 'a chat not loaded yet plans the same');
  // its note: MoPilot's Chrome through chrome_*, never the rule for picking among the plugin's Chrome backends
  const note = inj.turnContext('th').context.value;
  const server = Object.keys(config.mcp_servers).find((k) => k.startsWith('sage'));
  assert.ok(note.includes(chromeToolsNote(server as string)), note);
  assert.match(note, /The Browser plugin has no Chrome backend in this chat/);
  // what Codex tried first in #1699, then gave up on: named, so it goes to the chrome_* tools instead
  assert.match(note, /"Browser is not available"\), and computer use can't control Google Chrome: don't try either/);
  assert.doesNotMatch(note, /ChatGPT extension|agent\.browsers\.get|cannot reach the user's Chrome/);
  // a native thread without MoPilot's tools (no sage-mcp) is still left without the plugin's Chrome
  const bare = inject({ chromeOff: () => cua, hasTools: false });
  assert.deepEqual(bare.sent.params.config.mcp_servers.cua_repl, cua);
});

test("CM-Z33: with the vendor's Chrome kept (or nothing to leave out), the thread loads as before: the plugin's Chrome, no chrome_* note", () => {
  const { inj, sent, hides } = inject({ chromeOff: () => null });
  assert.equal(sent.params.config.mcp_servers?.cua_repl, undefined);
  assert.equal(sent.params.config.plugins?.[CHROME_PLUGIN], undefined);
  assert.deepEqual(hides, [{ chrome: true, computer: true }]);
  assert.equal(inj.loadedPath('th')?.chrome, true);
  assert.doesNotMatch(inj.turnContext('th')?.context.value ?? '', /chrome_\* tools/);
  // no chromeOff given at all: the same
  assert.equal(inject().sent.params.config.mcp_servers?.cua_repl, undefined);
  // the plugin has no Chrome here and the thread isn't shown chrome_* either: the degraded note stays
  const degraded = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    nativeEnabled: () => true,
    nativeSurfaces: () => ({ chrome: false, computer: true }),
    visibleTools: () => ['browser_navigate'],
    degradedNote: (s: any) => (s.chrome ? null : 'DEGRADED CHROME'),
  });
  degraded.outgoing({ id: 1, method: 'thread/start', params: {} });
  degraded.observe({ id: 1, result: { thread: { id: 'th' } } });
  assert.match(degraded.turnContext('th').context.value, /DEGRADED CHROME/);
});

test("CM-Z33: MoPilot's own Chrome backend for the plugin runs only while the chrome_* tools are off (they replace it)", () => {
  const backends = (over: Record<string, boolean>) =>
    mainChromeBackends({
      live: {},
      server: {},
      isFlagEnabled: flags(over),
      shellEnv: { childEnv: () => ({}) },
      home: '/nonexistent',
      shipped: true,
    }).o.enabled();
  assert.equal(backends({}), false);
  assert.equal(backends({ 'shared.browser.chromeExtensionByDefault': false }), true);
  assert.equal(backends({ 'shared.browser.chromeExtensionByDefault': false, 'codex.browser.chromeExtension': false }), false);
});
