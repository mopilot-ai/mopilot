// The names an MCP server's tools are offered under (#2999 C0): <prefix><server>_<tag>_<tool>, the prefix the caller's (MoMo's momo_mcp_), each part lowercased to [a-z0-9_] (anything else becomes _), the tag a hash of the server's catalog key, at most 64 characters (the strictest harness's limit). A name that is too long, or that two of the server's tools would share after the mapping, ends in a 6-character hash of the catalog key and the tool's name instead. Names depend only on the prefix, the server's identity and its own tools, never on which servers run or in what order. A tool's identity for a rule is its name plus a hash of its input schema: a renamed or reshaped tool is a new tool.
const crypto = require('node:crypto');

const MAX = 64;

const hash = (/** @type {string} */ s, n = 6) => crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
const part = (/** @type {string} */ s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');

/** The longest the server's own name may be in a tool's name. */
const SERVER_MAX = 20;

/**
 * The names of one server's tools, a pure function of the prefix, the server's identity (its catalog key) and its tool
 * names: <prefix><server>_<tag>_<tool>, where tag is a hash of the catalog key, so two servers that share a display
 * name (`github` in Claude Code's and in Codex's config) never share a tool name, whatever order they start in. A tool
 * whose name is too long, or that maps to the same name as another of the server's tools (`a-b` and `a_b`), ends in a
 * hash of the catalog key and its own name instead, every one of them alike.
 * @param {{ key: string, name: string }} server @param {string[]} tools @param {string} prefix e.g. momo_mcp_
 * @returns {Map<string, string>} tool name → the name it is offered under
 */
function proxiedNames(server, tools, prefix) {
  const head = `${prefix}${part(server.name).slice(0, SERVER_MAX)}_${hash(server.key)}_`;
  const plain = (/** @type {string} */ tool) => `${head}${part(tool)}`;
  /** @type {Map<string, number>} */
  const uses = new Map();
  for (const tool of tools) uses.set(plain(tool), (uses.get(plain(tool)) ?? 0) + 1);
  return new Map(
    tools.map((tool) => {
      const name = plain(tool);
      if (name.length <= MAX && uses.get(name) === 1) return [tool, name];
      const tail = `_${hash(`${server.key}/${tool}`)}`;
      return [tool, `${name.slice(0, MAX - tail.length)}${tail}`];
    }),
  );
}

/** JSON with every object's keys sorted, so the same schema in another key order hashes the same. */
const stable = (/** @type {unknown} */ v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );

/** A tool's identity for an allowlist or rule: its name and its input schema. */
const toolKey = (/** @type {{ name: string, inputSchema?: unknown }} */ t) => `${t.name}#${hash(stable(t.inputSchema ?? null), 12)}`;

module.exports = { proxiedNames, toolKey };
