// How Claude Code sees the Registry's two host tool sets. Anthropic's own desktop app gives Claude the
// in-app browser and computer use as dedicated MCP servers whose tools carry short names (navigate,
// read_page, screenshot, left_click, ...). MoPilot's harness-neutral equivalents live in the Registry
// as browser_* (electron/capabilities/browser/hostTools.cjs) and desktop_* (electron/capabilities/tools/desktop.cjs);
// for Claude sessions each set gets its own SDK MCP server with those prefixes stripped, and every call is
// mapped back to the Registry name. The background desktop_app_* tools (electron/capabilities/tools/appScoped.cjs)
// land on mopilot_computer the same way, as app_screenshot, app_click, ..., app_batch: the names Claude knows
// for app-scoped control. The user's Chrome over MoPilot's relay (chrome_*, browser/chromeTools.cjs, B2) lands on
// mopilot_chrome under Claude in Chrome's names. Every other Registry tool stays on the session's sage_<nonce> server.
//
// The server names are MoPilot's own: never the vendor's reserved ones (Claude_Browser, computer-use,
// claude-in-chrome), which the CLI and the desktop app treat specially.

/** The host servers: which Registry names each one takes, and the short names they get there. */
const HOST_SERVERS = Object.freeze([
  Object.freeze({
    server: 'mopilot_browser',
    prefix: 'browser_',
    rename: Object.freeze({ browser_batch: 'browser_batch', browser_script: 'browser_script' }),
  }),
  Object.freeze({ server: 'mopilot_computer', prefix: 'desktop_', rename: Object.freeze({ desktop_batch: 'computer_batch' }) }),
  Object.freeze({ server: 'mopilot_chrome', prefix: 'chrome_', rename: Object.freeze({}) }),
  // the simulators (capabilities/tools/simulatorTools.cjs): ios_simulator_control lands as control on mopilot_ios_simulator
  Object.freeze({ server: 'mopilot_ios_simulator', prefix: 'ios_simulator_', rename: Object.freeze({}) }),
  Object.freeze({ server: 'mopilot_android_emulator', prefix: 'android_emulator_', rename: Object.freeze({}) }),
]);

/** Server names the vendor reserves for its own browser and computer-use tools (compared without case or separators). */
const RESERVED = ['Claude_Browser', 'computer-use', 'claude-in-chrome', 'Claude in Chrome'];
const fold = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const isReserved = (name) => RESERVED.some((r) => fold(r) === fold(name));
for (const h of HOST_SERVERS) if (isReserved(h.server)) throw new Error(`${h.server} is a reserved MCP server name`);

const HOST_SERVER_NAMES = Object.freeze(HOST_SERVERS.map((h) => h.server));

/**
 * Where a Registry tool is presented to Claude: its server and its name there. Host tools go to their
 * dedicated server under a short name; everything else keeps its name on the session's `sageServer`.
 */
function placement(registryName, sageServer) {
  for (const h of HOST_SERVERS) {
    if (!registryName.startsWith(h.prefix) || registryName.length <= h.prefix.length) continue;
    return { server: h.server, name: h.rename[registryName] ?? registryName.slice(h.prefix.length) };
  }
  return { server: sageServer, name: registryName };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A rewriter for tool text (descriptions, schema hints): names of tools that moved to a host server are
 * replaced by the name Claude knows them by, the short name inside the same server and the full
 * mcp__<server>__<name> form from any other. `placed` maps Registry name to {server, name}.
 */
function nameRewriter(placed) {
  const hosted = [...placed.entries()].filter(([, p]) => HOST_SERVER_NAMES.includes(p.server));
  if (!hosted.length) return () => (text) => text;
  const re = new RegExp(
    `\\b(${hosted
      .map(([reg]) => reg)
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join('|')})\\b`,
    'g',
  );
  const to = new Map(hosted);
  return (server) => (text) =>
    typeof text === 'string'
      ? text.replace(re, (reg) => {
          const p = to.get(reg);
          return p.server === server ? p.name : `mcp__${p.server}__${p.name}`;
        })
      : text;
}

/** A JSON Schema with its string values passed through `rewrite` (a copy; the Registry's own is untouched). */
function rewriteSchema(schema, rewrite) {
  if (schema === null || typeof schema !== 'object') return schema;
  const json = JSON.stringify(schema);
  const out = JSON.stringify(schema, (_k, v) => (typeof v === 'string' ? rewrite(v) : v));
  return out === json ? schema : JSON.parse(out);
}

/**
 * Tools whose successful result is the user's or a page's own text (the clipboard, page text, a script's
 * value, console and network logs, history): it goes to Claude as it is, never rewritten. Their refusals are
 * MoPilot's text and are rewritten like any other.
 */
const VERBATIM_RESULTS = Object.freeze(
  new Set([
    'desktop_read_clipboard',
    'browser_get_page_text',
    'browser_read_page',
    'browser_find',
    'browser_javascript_exec',
    'browser_read_console_messages',
    'browser_read_network_requests',
    'browser_history_search',
    'browser_bookmarks_search',
    // what a page's own tools (WebMCP) publish and answer
    'browser_page_tools',
    'browser_page_tool',
  ]),
);

/**
 * Tools whose results, refusals included, speak another computer's tool names (computer access, #1364: a paired
 * computer's tool list and what its tools answered). Those names are the ones to pass back to it, so they go to
 * Claude as they are: rewritten to this session's own names, a call would reach for a tool of this Mac's.
 */
const FOREIGN_RESULTS = Object.freeze(new Set(['remote_computer_tools', 'remote_computer_call', 'this_mac_control']));

/**
 * A tool result with its text items passed through `rewrite` (images and other items as they are): refusals
 * and hints name other tools ("call desktop_request_access first"), and Claude has to see the names it can call.
 * @param {{ content: { type: string, text?: string }[], isError?: boolean }} result
 * @param {(text: any) => any} rewrite leaves anything but a string as it is
 */
function rewriteResult(result, rewrite) {
  return { ...result, content: result.content.map((c) => (c.type === 'text' ? { ...c, text: rewrite(c.text) } : c)) };
}

module.exports = {
  HOST_SERVERS,
  HOST_SERVER_NAMES,
  RESERVED,
  isReserved,
  placement,
  nameRewriter,
  rewriteSchema,
  rewriteResult,
  VERBATIM_RESULTS,
  FOREIGN_RESULTS,
};
