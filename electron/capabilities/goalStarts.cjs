// Tells a goal that starts running (the user is back) from an update of one that was already running.

/**
 * A tracker fed every session patch: `starts(chatId, patch, refused)` is true when the patch makes the chat's goal active
 * that was not active before. An active goal also reports changes while it runs (Codex's token usage), which are not the
 * user coming back. Nor is a window's first report of a goal that a refusal paused: a window writes the goal back after
 * main's event, so that report can come after the refusal (#2758); only a report of it active after one of it inactive
 * since the refusal is the goal running again.
 */
function goalStarts() {
  /** @type {Set<string>} chats whose goal was last seen active */
  const active = new Set();
  /** @type {Set<string>} chats a refusal has paused, as of their last patch */
  const pausedNow = new Set();
  /** @type {Set<string>} paused chats whose goal no window has reported inactive since the refusal */
  const catchingUp = new Set();
  return {
    /**
     * @param {string} chatId @param {{ goal?: { status?: string } | null }} patch
     * @param {boolean} [refused] whether an unattended refusal has the chat paused
     */
    starts(chatId, patch, refused = false) {
      if (refused && !pausedNow.has(chatId)) catchingUp.add(chatId);
      if (refused) pausedNow.add(chatId);
      else {
        pausedNow.delete(chatId);
        catchingUp.delete(chatId);
      }
      if (!('goal' in patch)) return false;
      if (patch.goal?.status !== 'active') {
        active.delete(chatId);
        catchingUp.delete(chatId);
        return false;
      }
      const was = active.has(chatId) || catchingUp.has(chatId);
      active.add(chatId);
      return !was;
    },
  };
}

module.exports = { goalStarts };
