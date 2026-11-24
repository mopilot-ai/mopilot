// What the Mac's chat index tells main (electron/host/chatIndex.cjs): the windows hear each change of a machine's chats, and the desktop notifier hears a turn that ended or a card that waits on a machine, for chats this Mac does not already follow itself.
const { appChatId } = require('../../shared/host/chatIds.mjs');

/** What the Host called a chat or a machine, as one plain line fit for a banner: control characters, line breaks and the marks that reorder or hide text (bidi, zero-width) become spaces, and it is cut. @param {unknown} v @param {number} max */
const plain = (v, max) =>
  String(v ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * @param {object} o
 * @param {{ broadcastAll: (channel: string, payload: unknown) => void, live?: any }} o.deps main's window broadcast and live services (the notifier, the chats this Mac has, their ownership)
 * @param {() => boolean} o.allowed whether Host access is open
 * @param {() => { chatIndex: () => unknown, row: (id: string) => { name?: string } | undefined }} o.service the machines service
 * @returns {{ onChange: () => void, notify: (machineId: string, kind: 'turnEnded' | 'attention', row: { chatId: string, title: string }) => void }}
 */
function chatIndexHooks({ deps, allowed, service }) {
  return {
    onChange: () => deps.broadcastAll('host:chatIndex', allowed() ? service().chatIndex() : []),
    notify(machineId, kind, row) {
      const live = deps.live;
      const chatId = appChatId(row.chatId);
      // a chat this Mac has (a window's, or one it runs on a machine) notifies from its own session
      if (live.chats.records.has(chatId) || live.hostOwnership.get(chatId).hostId !== 'local') return;
      const where = plain(service().row(machineId)?.name, 60) || 'a machine';
      const title = plain(row.title, 120) || 'Chat';
      live.notifier?.notify(
        kind === 'turnEnded' ? 'turn' : 'approval',
        chatId,
        kind === 'turnEnded'
          ? { title, chatTitle: title, body: `Finished on ${where}` }
          : { title, chatTitle: title, body: `Needs you on ${where}` },
      );
    },
  };
}

module.exports = { chatIndexHooks };
