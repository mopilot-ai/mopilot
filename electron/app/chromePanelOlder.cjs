// A page of a chat's older rows for a phone paging back: the rows before the one it names, from the saved history and the chat's notes.
const { allRowsOf, pageOfRows } = require('../capabilities/browser/chromePanelLive.cjs');
const { CHAT_GONE_TEXT } = require('../chrome-extension/src/panelErrors.mjs');
const { withChatNotes, notesNeedWholeHistory } = require('../../shared/chatNotes.mjs');
const { isPhoneMomoChat } = require('./phoneMomoChat.cjs');
const { createPanelRowsCache } = require('./panelRowsCache.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services (the chat records)
 * @param {(chatId: string) => boolean} o.reachable whether a chat may be read
 * @param {((chatId: string, record: any) => Promise<{ turns: any[], earlierContentOmitted?: boolean }>) & { recent?: (chatId: string, o: { enough: (turns: any[]) => boolean }) => Promise<{ turns: any[], earlierContentOmitted?: boolean }>, stamp?: (chatId: string) => Promise<string | null> }} o.historyOf
 *   the chat's saved history; `recent` reads only its end, as far back as a page needs; `stamp` names what the history is now (null: it cannot, so nothing is held)
 * @param {ReturnType<typeof createPanelRowsCache>} [o.cache] the rows held between pages
 */
function createPanelOlder({ live, reachable, historyOf, cache = createPanelRowsCache() }) {
  /** The page before the row `before`, or null when that row is no longer in the saved history. @param {string} chatId @param {string} before @param {number} limit */
  return async (chatId, before, limit) => {
    if (!reachable(chatId)) throw new Error(CHAT_GONE_TEXT);
    const record = live.chats.records.get(chatId);
    const notes = () => {
      const saved = live.chats.records.get(chatId)?.meta?.notes;
      return Array.isArray(saved) ? saved : [];
    };
    const momo = isPhoneMomoChat(live, chatId);
    // what the rows are made from, taken before the history is read: a history that changes during the read is another stamp at the next page, never this one's
    const stamp = record ? await stampOf(historyOf, chatId) : null;
    const variant = JSON.stringify([momo, notes()]);
    if (stamp) {
      const held = cache.get(chatId, stamp, variant);
      const page = held && pageOfRows(held.rows, before, limit);
      // a page that reaches the first row held is not the chat's first page unless that row began the history: the rows before it were not read
      if (page && (page.more || !held.omitted)) return { ...page, omitted: false };
    }
    /** @type {{ turns: any[], rows: any[] } | null} the rows of the last turns seen: a window read again for the same turns is not translated again */
    let made = null;
    const rowsOf = (/** @type {any[]} */ turns) =>
      made?.turns === turns ? made.rows : (made = { turns, rows: allRowsOf(withChatNotes(turns, notes()), false, momo) }).rows;
    // the end of the history that holds the row asked for and a page of rows before it, with some still earlier: a page that ended at
    // the start of what was read would say there is no more, when there are only turns this read left out
    // a note with no turn id is placed by its index among all the chat's turns: such a chat is read whole
    const history = !record
      ? { turns: [], earlierContentOmitted: false }
      : historyOf.recent && !notesNeedWholeHistory(notes())
        ? await historyOf.recent(chatId, { enough: (turns) => !!pageOfRows(rowsOf(turns), before, limit)?.more })
        : await historyOf(chatId, record);
    const rows = rowsOf(history.turns);
    const page = pageOfRows(rows, before, limit);
    if (stamp && page) cache.set(chatId, { rows, stamp, variant, omitted: !!history.earlierContentOmitted });
    // content the history source left out cannot be paged to: `omitted` says so once the rows it holds are all shown, instead of offering more
    return page && { ...page, omitted: !page.more && !!history.earlierContentOmitted };
  };
}

/** The history's stamp, or null when it has none or cannot say (a failed stamp holds nothing, and the page is read as it always was). @param {any} historyOf @param {string} chatId */
async function stampOf(historyOf, chatId) {
  if (typeof historyOf.stamp !== 'function') return null;
  try {
    return (await historyOf.stamp(chatId)) || null;
  } catch (error) {
    noteIgnored("name the state of a chat's saved history", error);
    return null;
  }
}

module.exports = { createPanelOlder };
