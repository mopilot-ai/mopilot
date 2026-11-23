// The coding-side MCP servers MoPilot can offer through its own tools (#2999 C0; MoMo's first), read only from where coding chats already configure them, never edited: MoPilot's plugin store (its enabled, trusted plugins' servers, handed in by main), Claude Code's user-scope `mcpServers` in .claude.json, and Codex's `[mcp_servers]` in config.toml. Each becomes one entry keyed `<origin>:<name>` with its launch (a command, its arguments and the env its config declares) or its streamable HTTP URL and headers; an SSE server, or anything that is neither, is left out. A file that is missing or can't be read lists nothing from it.
const { fs } = require('../platform/ports/fs.cjs');
const { parse: parseToml } = require('smol-toml');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @typedef {{ type: 'stdio', command: string, args: string[], env: Record<string, string> }} StdioLaunch
 * @typedef {{ type: 'http', url: string, headers: Record<string, string> }} HttpLaunch
 * @typedef {{ key: string, name: string, origin: 'plugin' | 'claude' | 'codex', from: string, launch: StdioLaunch | HttpLaunch }} CatalogEntry
 *   from: where it is configured, as Settings says it
 */

const record = (/** @type {unknown} */ v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {};
/** Only string values: what a config declares as env or headers. */
const strings = (/** @type {unknown} */ v) => Object.fromEntries(Object.entries(record(v)).filter(([, x]) => typeof x === 'string'));

/** One config entry as a launch, or null when it names neither a command nor a URL. @returns {StdioLaunch | HttpLaunch | null} */
function launchOf(/** @type {unknown} */ v) {
  const s = record(v);
  // the older SSE transport is not offered to MoMo
  if (s.type === 'sse') return null;
  if (typeof s.command === 'string' && s.command && s.type !== 'http')
    return { type: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: strings(s.env) };
  if (typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
    return { type: 'http', url: s.url, headers: strings(s.headers ?? s.http_headers) };
  return null;
}

/** The servers in one config's name → entry map, as catalog entries of `origin`. */
function entries(/** @type {unknown} */ servers, /** @type {CatalogEntry['origin']} */ origin, /** @type {string} */ from) {
  /** @type {CatalogEntry[]} */
  const out = [];
  for (const [name, v] of Object.entries(record(servers))) {
    const launch = launchOf(v);
    if (launch) out.push({ key: `${origin}:${name}`, name, origin, from, launch });
  }
  return out;
}

/** A config file's text, or null when it is missing or unreadable (noted, unless missing). */
function readText(/** @type {string} */ file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    noteIgnored(`read the MCP servers in ${file}`, error, ['ENOENT']);
    return null;
  }
}

/** A parsed config, or null when it can't be parsed (noted). */
function parsed(/** @type {string} */ file, /** @type {(text: string) => unknown} */ parse) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return parse(text);
  } catch (error) {
    noteIgnored(`parse the MCP servers in ${file}`, error);
    return null;
  }
}

/**
 * Every server the coding side configures, plugins first.
 * @param {{ plugins: () => Promise<{ id: string, servers: Record<string, unknown> }[]>, claudeConfig: string, codexConfig: string }} o
 *   plugins: the enabled, trusted plugins' MCP servers; claudeConfig: Claude Code's .claude.json; codexConfig: Codex's config.toml
 * @returns {Promise<CatalogEntry[]>}
 */
async function readCatalog({ plugins, claudeConfig, codexConfig }) {
  // a plugin store that can't be read hides only the plugins' servers
  const listed = await plugins().catch((/** @type {unknown} */ error) => {
    noteIgnored("read the plugin store's MCP servers for MoMo", error);
    return [];
  });
  const fromPlugins = listed.flatMap((p) =>
    entries(p.servers, 'plugin', `the ${p.id} plugin`).map((e) => ({ ...e, key: `plugin:${p.id}/${e.name}` })),
  );
  const claude = record(parsed(claudeConfig, JSON.parse)).mcpServers;
  const codex = record(parsed(codexConfig, parseToml)).mcp_servers;
  return [...fromPlugins, ...entries(claude, 'claude', 'Claude Code'), ...entries(codex, 'codex', 'Codex')];
}

module.exports = { readCatalog, launchOf };
