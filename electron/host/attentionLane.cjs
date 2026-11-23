// What each machine chat waits for, as its Host's state lane says it (`attention`, U1/U4/U5): kept by chat, pushed to the windows on every change and readable for a window opened later. A Host that sends none leaves a chat out.

const KINDS = new Set(['approval', 'paused', 'credential', 'limit']);

/**
 * A value of the state lane as an attention, or null for none; anything this app does not know is none (an older app meets a newer Host).
 * @param {unknown} v @returns {{ kind: string, reason?: string, since?: number, pauseMinutes?: number } | null}
 */
function readAttention(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const a = /** @type {Record<string, unknown>} */ (v);
  if (typeof a.kind !== 'string' || !KINDS.has(a.kind)) return null;
  return {
    kind: a.kind,
    ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
    ...(typeof a.since === 'number' && Number.isFinite(a.since) ? { since: a.since } : {}),
    // the minutes the owner's clock gave the card that went unanswered (paused only): the strip says them
    ...(a.kind === 'paused' && typeof a.pauseMinutes === 'number' && Number.isSafeInteger(a.pauseMinutes) && a.pauseMinutes > 0
      ? { pauseMinutes: a.pauseMinutes }
      : {}),
  };
}

/** @param {{ broadcast: (event: { chatId: string, attention: object | null }) => void }} o */
function createAttentionLane({ broadcast }) {
  /** @type {Map<string, object>} */
  const held = new Map();
  return {
    /** The Host told the chat's attention (null or unknown: none). Unchanged tells nobody. @param {string} chatId @param {unknown} value */
    set(chatId, value) {
      const next = readAttention(value);
      if (JSON.stringify(held.get(chatId) ?? null) === JSON.stringify(next)) return;
      if (next) held.set(chatId, next);
      else held.delete(chatId);
      broadcast({ chatId, attention: next });
    },
    /** Every chat that waits for something, for a window that opens now. */
    all: () => Object.fromEntries(held),
  };
}

/**
 * The lane and its read for a window opened later (`host:attentions`; nothing while Host is off).
 * @param {{ handle: (channel: string, fn: () => unknown) => void }} ipcMain @param {() => boolean} allowed @param {(e: { chatId: string, attention: object | null }) => void} broadcast
 */
function registerAttention(ipcMain, allowed, broadcast) {
  const lane = createAttentionLane({ broadcast });
  ipcMain.handle('host:attentions', () => (allowed() ? lane.all() : {}));
  return lane;
}

module.exports = { createAttentionLane, readAttention, registerAttention };
