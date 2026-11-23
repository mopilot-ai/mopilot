// A Claude Code session's own copies of the MCP servers MoPilot's gateway runs never load (#2999 C4), for that session only and never by editing the user's files: the session's flag settings (the `--settings` layer, which lasts as long as the process) deny each such server by its identity (deniedMcpServers: its command and arguments, or its URL; gateway/native.cjs denialsOf). Claude Code applies the deny list to every scope it loads a server from: user, project, local, a parent folder's `.mcp.json`, enterprise, and plugins. Only those identities go into the session, never a server's env, headers or credential.

/**
 * Adds the gateway's deny entries to a session's flag settings, after any it has already.
 * @param {Record<string, any>} options the session's SDK options @param {object[]} denials
 * @returns {object[]} the entries added
 */
function denyManaged(options, denials) {
  if (!Array.isArray(denials) || !denials.length) return [];
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : {};
  const prior = Array.isArray(settings.deniedMcpServers) ? settings.deniedMcpServers : [];
  options.settings = { ...settings, deniedMcpServers: [...prior, ...denials] };
  return denials;
}

module.exports = { denyManaged };
