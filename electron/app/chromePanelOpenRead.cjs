// What a paired phone opening a chat reads of its history: the last rows, and the last turns its cards come from, read from the end of the history, not all of it.
const { recentRowsOf } = require('../capabilities/browser/chromePanelLive.cjs');
const { CHAT_GONE_TEXT } = require('../chrome-extension/src/panelErrors.mjs');
const { withChatNotes, notesNeedWholeHistory } = require('../../shared/chatNotes.mjs');
const { stateOf } = require('../remote/chatState.cjs');
const { isPhoneMomoChat } = require('./phoneMomoChat.cjs');

/**
 * How many of a chat's last turns a phone's cards are read from: a question the agent asked in a message is offered while it is
 * unanswered, and one from before these is not (answering one reads the whole history).
 */
const CARD_TURNS = 3;

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services (the chat records, the controller's state)
 * @param {(chatId: string) => boolean} o.reachable whether the panel may read a chat
 * @param {ReturnType<typeof import('./chromePanelHistory.cjs').createHistoryReader>} o.historyOf the chat's saved history, with its `recent` read
 * @param {(chatId: string, o?: { exceptLive?: boolean }) => any[] | null} [o.forkTurns] a side chat's turns, which nothing saves (null for any other chat)
 */
function createOpenReads({ live, reachable, historyOf, forkTurns = () => null }) {
  /** A chat a phone's snapshot may read: one the panel may, or MoMo's current main chat (chat.follow refuses MoMo's chats first; the service gates momo.*). */
  const readable = (/** @type {string} */ chatId) => reachable(chatId) || live.momo?.mainChat.usable(chatId) === true;
  return {
    /** Whether a phone's read of the chat is MoMo's: its replies' Options lines go out as `options` (phoneMomoChat.cjs). @param {string} chatId */
    momoChat: (chatId) => isPhoneMomoChat(live, chatId),
    /**
     * The last `n` rows of a chat as the panel's `read` has them, read from the end of its history: the turns before the ones that
     * make those rows are not read. What a phone is first sent when it opens the chat, so the cost does not grow with the chat.
     * @param {string} chatId @param {number} n
     */
    async rows(chatId, n) {
      const record = live.chats.records.get(chatId);
      const present = () => readable(chatId) && (!record || live.chats.records.has(chatId));
      if (!present()) throw new Error(CHAT_GONE_TEXT);
      const running = stateOf(live.controller.state.get(chatId)?.turn) !== 'idle';
      // a side chat is read from what the feed kept of it, apart from the live turn a snapshot sends as live
      const fork = forkTurns(chatId, { exceptLive: true });
      if (fork) return recentRowsOf(fork, { running }).rows.slice(-n);
      const notes = () => {
        const saved = live.chats.records.get(chatId)?.meta?.notes;
        return Array.isArray(saved) ? saved : [];
      };
      const momo = isPhoneMomoChat(live, chatId);
      const rowsFor = (/** @type {any[]} */ turns) => recentRowsOf(withChatNotes(turns, notes()), { running, momo });
      let history;
      try {
        // a note with no turn id is placed by its index among all the chat's turns: such a chat is read whole
        history = !record
          ? { turns: [] }
          : notesNeedWholeHistory(notes())
            ? await historyOf(chatId, record, running)
            : await historyOf.recent(chatId, {
                open: running,
                enough: (turns) => {
                  const { rows, limited } = rowsFor(turns);
                  // the rows asked for, or the limits of a panel read reached: no earlier history changes them
                  return limited || rows.length >= n;
                },
              });
      } catch (error) {
        if (!present()) throw new Error(CHAT_GONE_TEXT);
        throw error;
      }
      if (!present()) throw new Error(CHAT_GONE_TEXT);
      return rowsFor(history.turns).rows.slice(-n);
    },
    /** The turns a phone's cards are read from: the last few. @param {string} chatId */
    cardTurns: (chatId) => historyOf.recent(chatId, { enough: (turns) => turns.length >= CARD_TURNS }),
  };
}

module.exports = { createOpenReads, CARD_TURNS };
