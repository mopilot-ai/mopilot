// What the receiving user is told about a peer message with no window on its chat: delivered, or held for their Allow.

const { prefixUnits } = require('../../shared/textPrefix.mjs');

/**
 * The journal publisher: windows refresh, and each newly delivered or newly held message marks its chat unread
 * and notifies once. Messages already in the journal at startup are not announced again.
 * @param {{ broadcastAll: (channel: string, data?: any) => void, chatInView: (id: string) => boolean, chats: any,
 *   notifier: () => any, chatName: (id: string) => string | null | undefined }} o
 */
function createPeerNotices({ broadcastAll, chatInView, chats, notifier, chatName }) {
  let ready = false;
  const announced = new Set();
  const key = (/** @type {any} */ m) => (m.delivery === 'held' ? `held:${m.id}` : m.delivery === 'delivered' ? m.id : null);
  return {
    /** @param {{ messages: any[] }} journal */
    publish(journal) {
      broadcastAll('peer:changed');
      if (!ready) return;
      for (const message of journal.messages) {
        const k = key(message);
        if (!k || announced.has(k)) continue;
        announced.add(k);
        const held = message.delivery === 'held';
        if (!chatInView(message.targetChatId) && chats.records.has(message.targetChatId)) {
          chats.patchMeta(message.targetChatId, { unread: true });
          broadcastAll('chats:changed', { id: message.targetChatId, chat: chats.get(message.targetChatId) });
        }
        const from = message.sourceTitle || chatName(message.sourceChatId) || 'another chat';
        notifier()?.notify('turn', message.targetChatId, {
          title: held ? `Message from ${from} needs your approval` : `Message from ${from}`,
          body: prefixUnits(message.body, 180),
          chatTitle: message.targetTitle || chatName(message.targetChatId) || undefined,
          viewing: chatInView(message.targetChatId),
        });
      }
    },
    /** @param {{ messages: any[] }} journal the journal as loaded */
    start(journal) {
      for (const m of journal.messages) {
        const k = key(m);
        if (k) announced.add(k);
      }
      ready = true;
    },
  };
}

module.exports = { createPeerNotices };
