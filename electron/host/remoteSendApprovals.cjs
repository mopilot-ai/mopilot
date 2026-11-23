// How long a remote chat's approval cards have waited for an answer on this Mac: a card nobody answered for one period is one timeout, the third in a row pauses the run (design/host: Offline and queueing).
const { clock } = require('../platform/ports/clock.cjs');
const { createApprovalGuard } = require('./approvalGuard.cjs');

/**
 * @param {object} o
 * @param {(chatId: string) => void} o.pause stops the run on its machine and tells the user
 * @param {(error: Error) => void} o.report
 * @param {number} o.approvalMs how long cards may wait before a timeout counts
 * @param {(chatId: string) => boolean} o.engineOwns the machine's own approval engine keeps the clock for the chat
 * @param {(chatId: string) => boolean} o.isRemote the chat runs on a machine
 */
function createApprovalWaits({ pause, report, approvalMs, engineOwns, isRemote }) {
  const guard = createApprovalGuard({ pause, report });
  /** Chats with cards waiting: how many, and the timer of the period they have waited in. @type {Map<string, { count: number, timer: any }>} */
  const waiting = new Map();

  /** @param {string} chatId @param {number} count */
  function waitFor(chatId, count) {
    waiting.set(chatId, {
      count,
      timer: clock.setTimeout(() => expire(chatId), approvalMs),
    });
  }

  /** The cards are gone (answered, or the run ended): the count of timeouts in a row starts over. @param {string} chatId @param {{ timer: any }} have */
  function stopWaiting(chatId, have) {
    clock.clearTimeout(have.timer);
    waiting.delete(chatId);
    guard.answered(chatId);
  }

  /** A period passed with the cards unanswered: one timeout. The third pauses the run; a pause that failed is tried again after the next period. @param {string} chatId */
  function expire(chatId) {
    // every way out of waiting clears the timer, so a timer that fires has its entry
    const have = /** @type {{ count: number }} */ (waiting.get(chatId));
    if (guard.timedOut(chatId)) waiting.delete(chatId);
    else waitFor(chatId, have.count);
  }

  return {
    guard,
    /**
     * Every change to a chat's session state (SessionStore publish): when its approval cards change on a remote chat, the unanswered period starts, goes on or starts over.
     * The push to the phone is the controller's own (addApproval says "needs your approval" through the notifier); this adds the pause.
     * @param {{ chatId: string, patch?: { approvals?: unknown[] } }} p
     */
    onSessionPatch({ chatId, patch }) {
      if (!Array.isArray(patch?.approvals)) return;
      // the Host's engine times the cards of its chats: nothing here counts or pauses
      if (engineOwns(chatId)) return;
      const have = waiting.get(chatId);
      const count = patch.approvals.length;
      if (!count) return void (have && stopWaiting(chatId, have));
      if (have ? count >= have.count : !isRemote(chatId)) {
        if (have) have.count = count;
        return;
      }
      // the first card, or one was answered: the period starts over
      if (have) stopWaiting(chatId, have);
      waitFor(chatId, count);
    },
    dispose() {
      for (const { timer } of waiting.values()) clock.clearTimeout(timer);
      waiting.clear();
    },
  };
}

module.exports = { createApprovalWaits };
