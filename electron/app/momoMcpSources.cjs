// Where MoMo reads the MCP servers coding chats configure (#2999 C0, electron/gateway/catalog.cjs), read only: MoPilot's plugin store (the servers of the plugins a basic-harness session gets: enabled and still what the user trusted), Claude Code's .claude.json (CLAUDE_CONFIG_DIR's, else the home folder's) and Codex's config.toml (CODEX_HOME's, else ~/.codex).
const os = require('node:os');
const path = require('node:path');
const { createPluginService } = require('../plugins/service.cjs');

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string,
 *   store?: { enabledFor(family: string): Promise<{ deliver: { id: string, spec: any }[] }> } }} [o]
 */
function momoMcpSources({ env = process.env, home = os.homedir(), store } = {}) {
  return {
    plugins: async () => {
      const { deliver } = await (store ?? createPluginService({ home }).store).enabledFor('acp');
      return deliver.map((d) => ({ id: d.id, servers: d.spec.execution?.plans?.acp?.mcpServers ?? d.spec.mcpServers ?? {} }));
    },
    claudeConfig: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'),
    codexConfig: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
  };
}

module.exports = { momoMcpSources };
