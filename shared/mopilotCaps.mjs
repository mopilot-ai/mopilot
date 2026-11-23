// MoPilot's gateway capability table (GET /v1/models, `mopilot` on each entry), read by the main process
// (provider drops) and the renderer (which Claude models the gateway serves).

/** The gateway's table entry for a model: its id, or for a Claude alias (opus, sonnet[1m]) the newest gateway id containing it. */
export function gatewayEntry(table, id) {
  const hit = gatewayId(table, id);
  return hit ? table[hit] : null;
}

/** The gateway id a model resolves to (itself, or the newest Anthropic id containing a Claude alias), or null. */
export function gatewayId(table, id) {
  if (!table || !id) return null;
  if (table[id]) return id;
  const alias = String(id)
    .replace(/\[.*\]$/, '')
    .toLowerCase();
  if (!/^[a-z]+$/.test(alias)) return null;
  return (
    Object.keys(table)
      .filter((k) => k.toLowerCase().includes(alias) && (table[k].wires ?? []).includes('anthropic'))
      .sort()
      .pop() ?? null
  );
}

const ALIASES = new Set(['opus', 'sonnet', 'haiku']);

/**
 * Whether Claude Code on MoPilot credits can use a model: a listed id must speak the Anthropic wire, and
 * an opus/sonnet/haiku alias needs an Anthropic model of that family at a price. What the table doesn't
 * say about (no table yet, `default`, an id it has never seen) stays: the gateway decides.
 */
export function claudeModelServed(table, id) {
  if (!table || !Object.keys(table).length) return true;
  if (table[id]) return (table[id].wires ?? []).includes('anthropic');
  const alias = String(id)
    .replace(/\[.*\]$/, '')
    .toLowerCase();
  return ALIASES.has(alias) ? !!gatewayId(table, id) : true;
}

/**
 * Whether a model the table doesn't list goes without Fast, by harness: Claude Code's Fast is a gateway price the
 * table must list; Codex's service tier (and a basic harness's) is the gateway's to refuse.
 */
const UNLISTED_WITHOUT_FAST = { codex: false, claude: true };

/** The semantics the gateway can't serve for a model on this harness. Fast: the table says, and a Claude model it doesn't list stays without it. */
export function gatewayDrops(table, id, harness) {
  const entry = gatewayEntry(table, id);
  const drops = [];
  if (entry ? entry.fast === false : Object.hasOwn(UNLISTED_WITHOUT_FAST, harness) && UNLISTED_WITHOUT_FAST[harness]) drops.push('speed');
  for (const d of entry?.drops ?? []) if (!drops.includes(d)) drops.push(d);
  return drops;
}
