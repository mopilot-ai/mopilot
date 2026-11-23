// The MCP servers in opencode's own global settings, read only (#1575): what MoPilot's opencode chats load besides
// its own tools, and the layer that turns some off for MoPilot's process without touching the user's files.
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * JSONC as JSON: comments and trailing commas dropped outside strings (opencode reads its .jsonc files with
 * jsonc-parser, which accepts both).
 * @param {string} text
 */
function jsoncText(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * The global settings files opencode reads, in its order, later ones winning (packages/opencode/src/config/config.ts,
 * 1.18): config.json, opencode.json, opencode.jsonc in its config folder, then $OPENCODE_CONFIG.
 * @param {Record<string, string | undefined>} env
 */
function settingsFiles(env) {
  const home = env.HOME || os.homedir();
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map((f) => path.join(dir, f));
  if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG);
  return files;
}

/**
 * The servers opencode's global settings define: each name once, enabled unless a later file turns it off. A file that
 * is missing is skipped; one that doesn't parse is skipped too, as opencode itself would fail on it, and noted.
 * @param {Record<string, string | undefined>} env
 * @param {(file: string) => string} [read]
 * Each comes with its entry as the MCP gateway reads one (`config`: a local server's command and arguments, a remote
 * one's URL; null for anything else), so a server the gateway runs can be turned off here (#2999 C4).
 * @returns {{ name: string, enabled: boolean, config: { command: string, args: string[] } | { url: string } | null }[]}
 */
function opencodeServers(env, read = (f) => fs.readFileSync(f, 'utf8')) {
  /** @type {Map<string, { enabled: boolean, config: any }>} */
  const servers = new Map();
  for (const file of settingsFiles(env)) {
    let text;
    try {
      text = read(file);
    } catch (error) {
      noteIgnored("read opencode's settings", error, ['ENOENT', 'ENOTDIR']);
      continue;
    }
    let mcp;
    try {
      mcp = JSON.parse(jsoncText(text))?.mcp;
    } catch (error) {
      noteIgnored("read opencode's settings", error);
      continue;
    }
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) continue;
    for (const [name, server] of Object.entries(mcp)) {
      const on = server?.enabled;
      const before = servers.get(name);
      servers.set(name, {
        enabled: typeof on === 'boolean' ? on : (before?.enabled ?? true),
        // a later file that says where the server runs wins; one that only turns it on or off keeps the earlier
        config: launchEntry(server) ?? before?.config ?? null,
      });
    }
  }
  return [...servers].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name));
}

/** An opencode server entry as a config entry the gateway reads: a local one's command array as command and arguments, a remote one's URL. */
function launchEntry(/** @type {any} */ e) {
  if (e?.type === 'local' && Array.isArray(e.command) && typeof e.command[0] === 'string' && e.command[0])
    return { command: e.command[0], args: e.command.slice(1).map(String) };
  if (e?.type === 'remote' && typeof e.url === 'string') return { url: e.url };
  return null;
}

/**
 * The layer that turns servers off for this process only: `mcp.<name>.enabled = false` over MoPilot's own config,
 * which opencode merges after every settings file (OPENCODE_CONFIG_CONTENT).
 * @param {Record<string, unknown>} config MoPilot's own layer
 * @param {string[]} names
 */
function opencodeLayer(config, names) {
  const mcp = Object.fromEntries(names.map((n) => [n, { enabled: false }]));
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(names.length ? { ...config, mcp } : config) };
}

module.exports = { jsoncText, settingsFiles, opencodeServers, opencodeLayer };
