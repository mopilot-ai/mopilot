// Which of a Claude session's MoPilot tools are loaded into its context up front. Every tool's schema counts
// on every turn (~600 tokens each; ~190 tools were ~130k, 87% of a fresh chat), so only the core of each surface is
// always loaded; the rest sit behind Claude Code's ToolSearch, which lists a deferred tool by name only.
// Names are the ones the session sees: the host servers' short names (hostServers.cjs), the Registry's names on
// the session's sage_<nonce> server. Codex and ACP sessions reach the tools through sage-mcp: a harness without a tool
// search of its own gets the same core there, and the rest in groups (toolTiers.cjs).

const { APP_CORE } = require('./appTiers.cjs');

/**
 * The tools each host server always loads (presented names): the same core as a tiered session's (toolTiers.cjs CORE,
 * which tests/toolTiers.test.ts checks against this), so a chat that switches harness keeps the same first tools.
 */
const CORE_HOST = Object.freeze({
  // tabs_context and form_input wait behind ToolSearch: no request of a 24-task browse benchmark called either (G11)
  mopilot_browser: ['navigate', 'computer', 'read_page', 'find', 'browser_script'],
  // the desktop waits until a chat uses it: request_access starts a CU task and loads with the rest through ToolSearch (G11)
  mopilot_computer: [],
  // the user's Chrome's core, loaded up front only while the user's chosen browser is their Chrome (chromeCore below)
  mopilot_chrome: ['tabs_context_mcp', 'navigate', 'computer', 'read_page', 'find', 'form_input'],
});

/**
 * The turn tools the sage server always loads (Registry names): the same as a tiered session's app core
 * (appTiers.cjs APP_CORE). Every other app tool (sessions, panes, terminals, branches) loads through ToolSearch.
 */
const CORE_SAGE = APP_CORE;

/**
 * Whether tool `name` of `server` is loaded up front; `host` says whether `server` is one of the host servers.
 * `chromeCore`: the user chose their Chrome as the browser, so its core loads up front; otherwise a chat in the built-in
 * browser carries no second browser's schemas, and the Chrome tools are one ToolSearch away (toolTiers.cjs chrome group).
 */
function isCoreTool(server, name, host, chromeCore = false) {
  if (server === 'mopilot_chrome' && !chromeCore) return false;
  if (host) return !!CORE_HOST[server]?.includes(name);
  return CORE_SAGE.includes(name);
}

module.exports = { isCoreTool, CORE_HOST, CORE_SAGE };
