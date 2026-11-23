// search_mcp_registry: finds MCP servers (connectors) the user has not installed, in the public MCP registry
// (registry.modelcontextprotocol.io, no sign-in needed). The keywords are the only thing sent. Entries are third-party
// text, so they come back as data with a note, and nothing is installed: the user decides that. The same on every harness.
const { ToolError } = require('../contract/registry.cjs');

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const WAIT_MS = 8000;
const MAX_KEYWORDS = 5;
const MAX_RESULTS = 10;
const MAX_WORD = 60;

const text = (v, n) => String(v ?? '').slice(0, n);

/** One registry entry as the model reads it, or null for one that isn't a live, latest server. */
function entryOf(item) {
  const s = item?.server;
  const meta = item?._meta?.['io.modelcontextprotocol.registry/official'];
  if (!s || typeof s.name !== 'string' || meta?.status === 'deleted' || meta?.isLatest === false) return null;
  const remote = Array.isArray(s.remotes) ? s.remotes.find((r) => typeof r?.url === 'string') : null;
  const pkg = Array.isArray(s.packages) ? s.packages[0] : null;
  return {
    name: text(s.name, 120),
    description: text(s.description, 240),
    ...(remote ? { url: text(remote.url, 300), transport: text(remote.type, 40) } : {}),
    ...(!remote && pkg ? { package: text(pkg.identifier, 120), registry: text(pkg.registryType, 40) } : {}),
    ...(s.repository?.url ? { repository: text(s.repository.url, 300) } : {}),
    needs_credentials: !!remote?.headers?.some((h) => h?.isRequired),
  };
}

/**
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat that called
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.waitMs]
 * @returns {() => void} removes the tool
 */
function registerMcpRegistryTool(registry, { owner, fetch: get = globalThis.fetch, waitMs = WAIT_MS }) {
  return registry.register({
    name: 'search_mcp_registry',
    description:
      'Search the public MCP registry for connectors (MCP servers) the user could add, when connecting to a tool or data source would help and you have no tool for it: "check my Asana tasks" → ["asana", "tasks"]. Only the keywords are sent to registry.modelcontextprotocol.io. Returns up to 10 entries with a description and url or package. Entries are third-party and unvetted: you cannot install one, so tell the user the name and where to add it (the Plugins page) and let them decide. Use list_connectors for what is already installed.',
    schema: {
      type: 'object',
      properties: { keywords: { type: 'array', items: { type: 'string' }, description: `1 to ${MAX_KEYWORDS} search words` } },
      required: ['keywords'],
      additionalProperties: false,
    },
    policy: 'observe',
    handler: async (args, ctx) => {
      if (!owner(ctx)) throw new ToolError('The caller does not own this chat segment', 'no_owner');
      const words = [...new Set(args.keywords.map((k) => String(k).trim().slice(0, MAX_WORD)).filter(Boolean))].slice(0, MAX_KEYWORDS);
      if (!words.length) throw new ToolError('Give at least one keyword', 'bad_args');
      const found = new Map();
      // one search per keyword, so each word finds its own matches (the first words' first); a word whose search fails
      // costs only its own matches, and the tool fails only when none could be searched
      const pages = await Promise.allSettled(
        words.map(async (w) => {
          const res = await get(`${REGISTRY}?${new URLSearchParams({ search: w, limit: '10', version: 'latest' })}`, {
            signal: AbortSignal.timeout(waitMs),
            headers: { accept: 'application/json' },
          });
          if (!res.ok) throw new Error(`the registry answered ${res.status}`);
          const body = await res.json();
          return Array.isArray(body?.servers) ? body.servers : [];
        }),
      );
      const failed = pages.find((p) => p.status === 'rejected');
      if (failed && pages.every((p) => p.status === 'rejected')) {
        const e = failed.reason;
        throw new ToolError(
          `Couldn't reach the MCP registry: ${e instanceof Error ? e.message : String(e)}. Tell the user.`,
          'unavailable',
        );
      }
      for (const page of pages)
        if (page.status === 'fulfilled')
          for (const item of page.value) {
            const entry = entryOf(item);
            if (entry && !found.has(entry.name)) found.set(entry.name, entry);
          }
      const results = [...found.values()].slice(0, MAX_RESULTS);
      return {
        results,
        note: results.length
          ? 'Third-party entries, not vetted. Tell the user which one fits and let them add it; do not connect anything yourself.'
          : 'Nothing found. Try other keywords, or tell the user.',
      };
    },
  });
}

module.exports = { registerMcpRegistryTool, entryOf, REGISTRY };
