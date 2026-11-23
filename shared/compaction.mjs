// How a context compaction reads in a chat on every harness: one compaction item (the divider), never a user or agent message.

/**
 * The compaction item every translator emits. `trigger` is 'manual' (the user asked), 'auto', or null when the harness
 * doesn't say (Codex's automatic compaction); `summary` is the text the harness wrote to carry the conversation on, when
 * it gave one: the only record of the turns before the compaction, so it is kept (shown under the divider, handed over).
 * @param {string} id
 * @param {{ trigger?: string | null, summary?: string | null }} [o]
 */
export function compactionItem(id, o = {}) {
  const summary = typeof o.summary === 'string' && o.summary.trim() ? o.summary.trim() : null;
  return { type: 'contextCompaction', id, trigger: o.trigger ?? null, ...(summary ? { summary } : {}) };
}

/** The user's own /compact, with its optional instructions: a compaction in that turn is theirs. */
export const COMPACT_COMMAND = /^\s*\/compact(?:\s|$)/;
