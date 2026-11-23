// A native Codex thread whose Chrome MoPilot serves (#1319 G28, option A): the Browser plugin's Chrome family left out of its config, and the chrome_* tools in its place.
//
// The Codex Browser plugin picks among its Chrome backends itself, and with the ChatGPT extension connected it takes the
// vendor's, which has none of MoPilot's lock, overlay, Esc or site table (the G28 comparison run: 0 MoPilot calls).
// No note can hold that, and the plugin's env can't tell MoPilot's Chrome backend from the vendor's (same type and
// family). So when MoPilot serves the user's Chrome to a Codex chat, the thread gets no plugin Chrome at all:
// - its config defines cua_repl as the user's own MCP server, which replaces the plugin's of the same name: the plugin's
//   own definition (its materialized .mcp.json, read by iabBackend/environment.cjs pluginCuaServer) with the Chrome
//   family taken out of BROWSER_USE_AVAILABLE_BACKENDS and the Chrome use-case instructions left out; computer use and
//   the in-app browser ("iab", MoPilot's pane) stay;
// - the Chrome plugin (its skill and native host) is off for the thread;
// - the thread counts as not served Chrome by the plugin, so it is shown the chrome_* tools (visibility.cjs) and its
//   controller plan names MoPilot's Chrome.
// Without the plugin's definition (not installed, unreadable), nothing changes: the plugin keeps its Chrome.
const { noteIgnored } = require('../../ignored.cjs');
const { CHROME_BACKEND_KEYS, servedChrome, codexChromeRoute } = require('../browser/chromeControl.cjs');

/** The plugin that ships the Chrome skill and the ChatGPT extension's native host. */
const CHROME_PLUGIN = 'chrome@openai-bundled';
/** The plugin's MCP server for computer and browser use. */
const CUA_SERVER = 'cua_repl';
/** The fields of the plugin's server definition a user-level MCP server takes. */
const SERVER_FIELDS = [
  'command',
  'args',
  'cwd',
  'env_vars',
  'enabled_tools',
  'omit_tools_from',
  'startup_timeout_sec',
  'tool_timeout_sec',
  'tools',
];

/**
 * The plugin's cua_repl as a user-level MCP server without the Chrome family, or null when `server` (pluginCuaServer)
 * is not a definition to start from.
 * @param {Record<string, any> | null | undefined} server
 * @returns {Record<string, any> | null}
 */
function cuaWithoutChrome(server) {
  if (!server || typeof server.command !== 'string' || !server.env || typeof server.env !== 'object') return null;
  const env = { ...server.env };
  if (typeof env.BROWSER_USE_AVAILABLE_BACKENDS === 'string')
    env.BROWSER_USE_AVAILABLE_BACKENDS = env.BROWSER_USE_AVAILABLE_BACKENDS.split(',')
      .map((b) => b.trim())
      .filter((b) => b && !CHROME_BACKEND_KEYS.includes(b))
      .join(',');
  delete env.NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME;
  const def = Object.fromEntries(SERVER_FIELDS.filter((k) => server[k] !== undefined).map((k) => [k, server[k]]));
  return { ...def, enabled: true, env };
}

/**
 * The plugin's cua_repl as a user-level MCP server without its computer use (CUA_REPL_ENABLED_SURFACES less "computer"),
 * or null: for a thread whose computer use is MoPilot's (Codex Computer Use not chosen in Settings, or down) while
 * it keeps the plugin's Chrome (#1381). The plugin would otherwise offer Codex Computer Use beside the desktop_* tools.
 * @param {Record<string, any> | null | undefined} server
 */
function cuaWithoutComputer(server) {
  if (!server || typeof server.command !== 'string' || !server.env || typeof server.env !== 'object') return null;
  const listed = typeof server.env.CUA_REPL_ENABLED_SURFACES === 'string' ? server.env.CUA_REPL_ENABLED_SURFACES.split(',') : ['browser'];
  const surfaces = listed.map((s) => s.trim()).filter((s) => s && s !== 'computer');
  const def = Object.fromEntries(SERVER_FIELDS.filter((k) => server[k] !== undefined).map((k) => [k, server[k]]));
  return { ...def, enabled: true, env: { ...server.env, CUA_REPL_ENABLED_SURFACES: surfaces.join(',') } };
}

/**
 * The plugin's cua_repl without its Chrome while MoPilot serves the user's Chrome to Codex threads (codexChromeOn)
 * through the chrome_* tools (chromeToolsOn), else null: with those tools off, a Codex thread keeps the plugin's Chrome.
 * @param {{ isEnabled: (key: string) => boolean, shipped: boolean, server: () => Record<string, any> | null }} o
 *   server: the plugin's own cua_repl (iabBackend/environment.cjs pluginCuaServer), read only when it is needed
 */
function codexChromeOff({ isEnabled, shipped, server }) {
  return codexChromeRoute(servedChrome(isEnabled, { shipped })) === 'tools' ? cuaWithoutChrome(server()) : null;
}

/**
 * The surfaces a native thread loads with, and the cua_repl definition that changes the plugin's (`cua`): without its
 * Chrome when MoPilot serves the user's Chrome to the thread (`chromeOff`), else, for a thread that keeps the
 * plugin's Chrome but not its computer use, without its computer use (`computerOff`, cuaWithoutComputer); else null.
 * @param {{ chrome: boolean, computer: boolean }} surfaces what the plugin can serve on this Mac
 * @param {() => Record<string, any> | null} chromeOff
 * @param {() => Record<string, any> | null} [computerOff]
 */
function routedSurfaces(surfaces, chromeOff, computerOff = () => null) {
  const cua = surfaces.chrome ? chromeOff() : null;
  if (cua) return { surfaces: { ...surfaces, chrome: false }, cua };
  return { surfaces, cua: surfaces.chrome && !surfaces.computer ? computerOff() : null };
}

/** The config fragment that leaves the plugin's Chrome out of a native thread. @param {Record<string, any>} cua */
function pluginChromeOffConfig(cua) {
  return { mcp_servers: { [CUA_SERVER]: cua }, plugins: { [CHROME_PLUGIN]: { enabled: false } } };
}

/**
 * What a native thread shown the chrome_* tools is told about the user's Chrome: they are its only way there, the plugin
 * has none in this chat and computer use can't drive Chrome (#1699: Codex tried both first, then gave up).
 * @param {string} serverName the thread's sage-mcp server
 */
const chromeToolsNote = (serverName) =>
  `MoPilot's Chrome: the user's own Chrome, where they are signed in, is reached only through the chrome_* tools of the ${serverName} MCP server: start with chrome_tabs_context_mcp, which opens this chat's tab group, then chrome_navigate. The Browser plugin has no Chrome backend in this chat (a "chrome" browser there answers "Browser is not available"), and computer use can't control Google Chrome: don't try either, and don't give up because they fail. Use the chrome_* tools only when the user means their Chrome.`;

/** A selected own backend that failed to load never becomes the vendor's Chrome. */
function loadedChromeSurfaces(surfaces, own, pending = false) {
  return surfaces.chromeRoute === 'backend' && !own ? { ...surfaces, chrome: false, chromePending: pending } : surfaces;
}

/** Read the loaded backend's note without letting an optional note failure enter app-server traffic. */
function ownChromeNote(read, threadId) {
  try {
    return read(threadId);
  } catch (error) {
    noteIgnored("write the Chrome backend note into a Codex thread's instructions", error);
    return null;
  }
}

module.exports = {
  loadedChromeSurfaces,
  ownChromeNote,
  cuaWithoutChrome,
  cuaWithoutComputer,
  codexChromeOff,
  routedSurfaces,
  pluginChromeOffConfig,
  chromeToolsNote,
  CHROME_PLUGIN,
  CUA_SERVER,
};
