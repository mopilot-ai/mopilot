// Browser-plugin environment discovery and socket peer process verification.
const { fs: nodeFs } = require('../../../platform/ports/fs.cjs');
const path = require('node:path');
const { core } = require('../../../platform/core.cjs');
const { ancestryOf, peerPidOf } = require('../../mcp/socket.cjs');
const { noteIgnored } = require('../../../ignored.cjs');
const { versionsNewestFirst } = require('../../../../shared/skyComputerUse.mjs');
const CUA_PLUGIN_DIR = 'unified-computer-use';

/**
 * The plugin's cua_repl MCP server as its materialized .mcp.json in the Codex plugins cache defines it (the newest
 * version, compared as numbers, that defines one), or null.
 * @param {{ fs?: typeof nodeFs, codexHome: string }} o
 * @returns {Record<string, any> | null}
 */
function pluginCuaServer({ fs = nodeFs, codexHome }) {
  const dir = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', CUA_PLUGIN_DIR);
  let versions = [];
  try {
    versions = versionsNewestFirst(fs.readdirSync(dir));
  } catch (error) {
    // no plugin installed: nothing is available
    noteIgnored("list the Codex browser plugin's versions", error, ['ENOENT']);
  }
  for (const v of versions) {
    /** @type {any} */
    let server = null;
    try {
      server = JSON.parse(fs.readFileSync(path.join(dir, v, '.mcp.json'), 'utf8'))?.mcpServers?.cua_repl ?? null;
    } catch (error) {
      // an unreadable version: try the next
      noteIgnored("read a Codex browser plugin version's .mcp.json", error);
    }
    if (server && typeof server === 'object' && server.env && typeof server.env === 'object') return server;
  }
  return null;
}

/**
 * What the plugin's node_repl is given (pluginCuaServer's env): the backends it may use, and the build flavor and
 * version a session backend must match.
 * @param {{ fs?: typeof nodeFs, codexHome: string }} o
 * @returns {{ backends: string[], flavor: string | null, version: string | null }}
 */
function pluginBrowserEnv(o) {
  const env = pluginCuaServer(o)?.env;
  if (!env) return { backends: [], flavor: null, version: null };
  const str = (k) => (typeof env[k] === 'string' && env[k] ? env[k] : null);
  return {
    backends: (str('BROWSER_USE_AVAILABLE_BACKENDS') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    flavor: str('BROWSER_USE_CODEX_APP_BUILD_FLAVOR'),
    version: str('BROWSER_USE_CODEX_APP_VERSION'),
  };
}

/**
 * Null when the far end of `socket` is a process descended from `root` (the Codex app-server, or the ssh of a run), else
 * why not: the kernel names the peer (caps.peerPid) and the process table its ancestors (caps.ancestry). `root` itself is
 * not under `root`. A descendant may be any depth down, so no depth is cut from the chain.
 * @param {{ socket: any, root: number | null | undefined, addon?: ReturnType<typeof core> | null }} o
 */
async function verifyDescendant({ socket, root, addon = core() }) {
  if (!Number.isInteger(root)) return 'no harness process';
  const fd = socket._handle && socket._handle.fd;
  if (!Number.isInteger(fd) || fd < 0) return 'no socket';
  const peer = await peerPidOf(fd, addon);
  if (!Number.isInteger(peer) || peer <= 1) return 'socket not found';
  const chain = await ancestryOf(peer, addon);
  return chain?.slice(1).includes(/** @type {number} */ (root)) ? null : 'the peer is not under the harness';
}

module.exports = { pluginBrowserEnv, pluginCuaServer, verifyDescendant };
