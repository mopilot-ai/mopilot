// The rows a chat's saved history made for a phone paging back, held between pages so a page after the first is a slice and not a read of the transcript again (#5379).

/** The most chats held, the most their rows may weigh together (their JSON), and how long one that nobody asked for is kept. */
const MAX_CHATS = 6;
const MAX_BYTES = 48 * 1024 * 1024;
const IDLE_MS = 10 * 60_000;

/**
 * One chat's rows, kept only for what they were made from: `stamp` names the history they were read from (the transcript's file, size and
 * time, so an append, a compaction and an edit all change it) and `variant` what was done with it (a MoMo chat, the chat's notes). A reader
 * that asks with another stamp or variant gets nothing, and the entry is dropped. Memory is bounded by chats, by bytes and by idle time.
 * @param {{ maxChats?: number, maxBytes?: number, idleMs?: number, now?: () => number }} [o]
 */
function createPanelRowsCache({ maxChats = MAX_CHATS, maxBytes = MAX_BYTES, idleMs = IDLE_MS, now = Date.now } = {}) {
  /** @type {Map<string, { rows: any[], stamp: string, variant: string, omitted: boolean, bytes: number, used: number }>} oldest first */
  const held = new Map();
  let bytes = 0;
  const drop = (/** @type {string} */ chatId) => {
    bytes -= held.get(chatId)?.bytes ?? 0;
    held.delete(chatId);
  };
  const sweep = () => {
    for (const [chatId, entry] of held) if (now() - entry.used > idleMs) drop(chatId);
  };
  return {
    /** The chat's rows when they were made from this stamp and variant, and whether the history read held less than the chat had. */
    get(/** @type {string} */ chatId, /** @type {string} */ stamp, /** @type {string} */ variant) {
      sweep();
      const entry = held.get(chatId);
      if (!entry) return null;
      if (entry.stamp !== stamp || entry.variant !== variant) {
        drop(chatId);
        return null;
      }
      // taken out and put back last, so the least recently used go first
      held.delete(chatId);
      held.set(chatId, { ...entry, used: now() });
      return { rows: entry.rows, omitted: entry.omitted };
    },
    /** Keeps the rows (replacing the chat's earlier ones); rows too heavy for the bound are not kept. */
    set(/** @type {string} */ chatId, /** @type {{ rows: any[], stamp: string, variant: string, omitted: boolean }} */ entry) {
      drop(chatId);
      const weight = entry.rows.reduce((sum, row) => sum + JSON.stringify(row).length, 0);
      if (weight > maxBytes) return;
      sweep();
      held.set(chatId, { ...entry, bytes: weight, used: now() });
      bytes += weight;
      while (held.size > maxChats || bytes > maxBytes) drop(held.keys().next().value);
    },
    /** Lets a chat's rows go (a chat that was deleted). */
    forget: drop,
    /** What is held: chats and bytes. */
    size: () => ({ chats: held.size, bytes }),
  };
}

module.exports = { createPanelRowsCache, MAX_CHATS, MAX_BYTES, IDLE_MS };
