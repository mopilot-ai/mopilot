// Which of a harness's own MCP servers the gateway runs in its place (#2999 C4): a server entry from any harness's config (Claude Code's `.claude.json` or `.mcp.json`, Codex's config.toml, a plugin's `.mcp.json`, an ACP agent's settings, a live session's status) has the same identity as a managed server when its command and arguments, or its URL, are the same (servers.cjs serverKey); its env, headers and name don't count, as they don't for the managed server. An entry that is neither a command nor a streamable HTTP URL (an SSE server, anything else) is never matched: it stays the harness's own. Claude Code matches by the same identity itself, from the deny entries denialsOf gives.
const { launchOf } = require('./catalog.cjs');
const { serverKey, serverUrl } = require('./servers.cjs');

/** A harness config entry's server identity (servers.cjs serverKey), or null when it names no server the gateway could run. */
function nativeKey(/** @type {unknown} */ entry) {
  const launch = launchOf(entry);
  if (!launch) return null;
  if (launch.type === 'stdio') return serverKey({ type: 'stdio', command: launch.command, args: launch.args, env: {} });
  const url = serverUrl(launch.url);
  return url ? serverKey({ type: 'http', url, headers: {} }) : null;
}

/**
 * The names of `servers` (a harness's own, each with its config entry) that the gateway runs in their place.
 * @param {{ name: string, config: unknown }[]} servers @param {(entry: unknown) => boolean} isManaged
 * @returns {string[]} sorted
 */
function managedNames(servers, isManaged) {
  return servers
    .filter((s) => isManaged(s.config))
    .map((s) => s.name)
    .sort();
}

/**
 * Claude Code's deny entries (its `deniedMcpServers` setting) for the servers the gateway runs: a stdio server by its
 * command and arguments, matched exactly; a streamable HTTP server by its URL, spelled with and without a closing `/`
 * when it has a path and no query, as a user's config may write either. A host's root is only ever `https://h/`: Claude
 * Code reads `https://h` (no path, no closing `/`) as every path on that host, which would deny servers the gateway
 * doesn't run. Only identities: never a server's env, headers or credential.
 * @param {{ launch: { type: string, command?: string, args?: string[], url?: string } }[]} servers
 * @returns {({ serverCommand: string[] } | { serverUrl: string })[]}
 */
function denialsOf(servers) {
  /** @type {({ serverCommand: string[] } | { serverUrl: string })[]} */
  const out = [];
  for (const { launch } of servers) out.push(...denialOf(launch));
  return out;
}

/**
 * One server's deny entries (denialsOf). @param {{ type: string, command?: string, args?: string[], url?: string }} launch
 * @returns {({ serverCommand: string[] } | { serverUrl: string })[]}
 */
function denialOf(launch) {
  if (launch.type === 'stdio' && launch.command) return [{ serverCommand: [launch.command, ...(launch.args ?? [])] }];
  const url = launch.type === 'http' ? serverUrl(launch.url) : null;
  if (!url) return [];
  // serverUrl's href: a root is always written `…/`, the one spelling that matches it alone (with or without its `/`)
  if (url.includes('?') || new URL(url).pathname === '/') return [{ serverUrl: url }];
  return [{ serverUrl: url }, { serverUrl: url.endsWith('/') ? url.slice(0, -1) : `${url}/` }];
}

module.exports = { nativeKey, managedNames, denialsOf };
