// MCP server settings, as pure functions: merging an edited Codex server into its config.toml table
// without dropping keys the editor doesn't know, and building the `claude mcp add` command.

/** The keys Settings' MCP editor owns. Every other key in the table is the user's and is kept. */
export const CODEX_MCP_EDITED = [
  'command',
  'args',
  'env',
  'env_vars',
  'cwd',
  'url',
  'bearer_token_env_var',
  'http_headers',
  'env_http_headers',
];

/** The table to write for an edited server: the original with the edited keys replaced, nothing else lost. */
export function mergeCodexMcp(
  original: Record<string, unknown> | null | undefined,
  edited: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(original ?? {}) };
  for (const k of CODEX_MCP_EDITED) delete out[k];
  for (const [k, v] of Object.entries(edited)) out[k] = v;
  return out;
}

export interface ClaudeMcpForm {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  /** stdio: the program and its arguments, one per entry; http and sse: the URL */
  command: string;
  args: string[];
  url: string;
  env: { key: string; value: string }[];
  headers: { key: string; value: string }[];
}

export const MCP_NAME = /^[\w.-]+$/;

/** Why the form can't be run yet, or null. */
export function claudeMcpProblem(f: ClaudeMcpForm): string | null {
  if (!MCP_NAME.test(f.name.trim())) return 'Name: letters, numbers, dot, dash and underscore only';
  if (f.type === 'stdio' ? !f.command.trim() : !/^https?:\/\//.test(f.url.trim()))
    return f.type === 'stdio' ? 'Enter the command to run' : 'Enter a URL starting with http:// or https://';
  return null;
}

/** argv for `claude mcp add --scope user …`. User scope: the server is available in every project. */
export function claudeMcpAddArgv(bin: string, f: ClaudeMcpForm): string[] {
  const argv = [bin, 'mcp', 'add', '--scope', 'user'];
  if (f.type !== 'stdio') argv.push('--transport', f.type);
  for (const e of f.env) if (e.key.trim()) argv.push('--env', `${e.key.trim()}=${e.value}`);
  if (f.type !== 'stdio') for (const h of f.headers) if (h.key.trim()) argv.push('--header', `${h.key.trim()}: ${h.value}`);
  argv.push(f.name.trim());
  if (f.type === 'stdio') argv.push('--', f.command.trim(), ...f.args.map((a) => a.trim()).filter(Boolean));
  else argv.push(f.url.trim());
  return argv;
}

/** One shell line for showing the command before it runs. */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}
