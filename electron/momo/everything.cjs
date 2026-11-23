// What "Everything" shows in MoMo's rail (A2): the latest finished exchanges of MoMo's main chat and of every open channel's chat, newest first, each with the name of the channel it was said in ("Main" for the main chat), optionally for one channel only. Read from MoMo's index of its chats (historyIndex.cjs `recent`), so a channel archived or deleted has no row and an exchange that is still running shows in its own chat, not here. It reads and changes nothing else; refused with the other channel calls while MoMo is not allowed or channels are off.

/** The words that name MoMo's main chat in the rows and the filter. */
const MAIN_NAME = 'Main';
/** The most rows one read returns. */
const MAX_ROWS = 100;
/** The longest text of one side of a row; the chat holds the rest. */
const CLIP = 400;

const clip = (/** @type {string} */ s) => {
  const t = s.trim();
  return t.length > CLIP ? `${t.slice(0, CLIP - 1).trimEnd()}…` : t;
};

/**
 * @param {{ recent: (chatIds: string[], limit: number) => { chatId: string, turnId: string, at: number, user: string, assistant: string }[] | null,
 *   channels: { list: () => { channels: { id: string, name: string }[] }, chatIdOf: (id: string) => string | null },
 *   mainChatId: () => string | null }} o
 *   recent: the newest chunks of those chats, null when the index can't be read now
 */
function createEverything({ recent, channels, mainChatId }) {
  return {
    /**
     * @param {unknown} [only] 'main' or a channel's id: only that chat's rows; left out, all of them
     * @returns {{ rows: { chatId: string, turnId: string, channelId: string | null, name: string, at: number, user: string, assistant: string }[],
     *   filters: { id: string, name: string }[], unavailable: boolean }}
     */
    list(only) {
      /** @type {Map<string, { channelId: string | null, name: string }>} */
      const chats = new Map();
      const main = mainChatId();
      if (main) chats.set(main, { channelId: null, name: MAIN_NAME });
      const open = channels.list().channels;
      for (const c of open) {
        const chatId = channels.chatIdOf(c.id);
        if (chatId) chats.set(chatId, { channelId: c.id, name: c.name });
      }
      const filters = [{ id: 'main', name: MAIN_NAME }, ...open.map((c) => ({ id: c.id, name: c.name }))];
      const wanted = [...chats].filter(
        ([, v]) => only === undefined || only === null || (only === 'main' ? v.channelId === null : v.channelId === only),
      );
      const found = wanted.length
        ? recent(
            wanted.map(([id]) => id),
            MAX_ROWS,
          )
        : [];
      if (!found) return { rows: [], filters, unavailable: true };
      const rows = found.flatMap((r) => {
        const v = chats.get(r.chatId);
        return v
          ? [
              {
                chatId: r.chatId,
                turnId: r.turnId,
                channelId: v.channelId,
                name: v.name,
                at: r.at,
                user: clip(r.user),
                assistant: clip(r.assistant),
              },
            ]
          : [];
      });
      return { rows, filters, unavailable: false };
    },
  };
}

module.exports = { createEverything, MAIN_NAME, MAX_ROWS, CLIP };
