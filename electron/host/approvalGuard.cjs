// Approvals on a Host that has no approval engine (no approvals2): three timeouts in a row pause the run instead of waiting forever. A Host with the engine owns the clock and the app only reads it (remoteSend.cjs).
const LIMIT = 3;

/**
 * @param {object} o
 * @param {(chatId: string) => void} o.pause pauses the run with a visible state; may throw
 * @param {number} [o.limit]
 * @param {(error: Error) => void} [o.report] where a failed pause is reported
 */
function createApprovalGuard({ pause, limit = LIMIT, report }) {
  /** Consecutive timeouts per chat. @type {Map<string, number>} */
  const timeouts = new Map();
  /** @type {Set<string>} */
  const paused = new Set();

  return {
    /** A card timed out unanswered. Returns whether the run is now paused. @param {string} chatId */
    timedOut(chatId) {
      if (paused.has(chatId)) return true;
      const count = (timeouts.get(chatId) ?? 0) + 1;
      timeouts.set(chatId, count);
      if (count < limit) return false;
      try {
        pause(chatId);
      } catch (error) {
        // not paused: the next timeout tries again
        report?.(error);
        return false;
      }
      paused.add(chatId);
      return true;
    },
    /** The user answered a card: the count starts over. @param {string} chatId */
    answered(chatId) {
      timeouts.delete(chatId);
    },
    /** The user resumed the run. @param {string} chatId */
    resumed(chatId) {
      timeouts.delete(chatId);
      paused.delete(chatId);
    },
    isPaused: (/** @type {string} */ chatId) => paused.has(chatId),
  };
}

module.exports = { createApprovalGuard, LIMIT };
