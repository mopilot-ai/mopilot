// The draft card's Send in main (MoMo's draft card design): three IPC calls over the draft sender (momo/draftSend.cjs), every one refused while MoMo is not allowed for the account, so an account without the invite sees and reaches nothing. momoDraft:accounts lists the connected mail accounts for the From chooser, momoDraft:send sends the card's words from one of them, and momoDraft:state reads a note's send; every change of a note's send is broadcast as momoDraft:state (ids and the send's own fields, never the words). The window names a chat, a note and an account id: main takes the words from the card, checks them as the draft tool does, and never lets a window name a connector tool, a URL or a sender it did not list.
const { createDraftSender } = require('../momo/draftSend.cjs');

const CHANNELS = Object.freeze(['momoDraft:accounts', 'momoDraft:state', 'momoDraft:send']);
const NOT_ALLOWED = Object.freeze({
  ok: false,
  reason: 'not_allowed',
  error: 'MoMo is not available',
});
const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ sender: ReturnType<typeof createDraftSender>, allowed: () => boolean }} o
 * @returns {() => void} removes the handlers
 */
function registerDraftSendIpc(ipcMain, { sender, allowed }) {
  ipcMain.handle('momoDraft:accounts', () => (allowed() === true ? { ok: true, accounts: sender.accounts() } : NOT_ALLOWED));
  ipcMain.handle('momoDraft:state', (_e, input) =>
    allowed() === true
      ? {
          ok: true,
          send: sender.state(text(input?.chatId), text(input?.noteId)),
        }
      : NOT_ALLOWED,
  );
  ipcMain.handle('momoDraft:send', async (_e, input) => {
    if (allowed() !== true) return NOT_ALLOWED;
    return sender.send({
      chatId: text(input?.chatId),
      noteId: text(input?.noteId),
      from: text(input?.from),
      words: { to: input?.to, subject: input?.subject, body: input?.body },
    });
  });
  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

/**
 * Builds the sender over MoMo's connector hub and the chat store, registers its IPC, and settles the sends the app stopped on.
 * @param {{ ipcMain: Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>, hub: any, live: any,
 *   broadcastAll: (channel: string, payload?: unknown) => void, allowed: () => boolean, isMomoChat: (chatId: string) => boolean }} o
 */
function openMomoDraftSend({ ipcMain, hub, live, broadcastAll, allowed, isMomoChat }) {
  const sender = createDraftSender({
    hub,
    chats: live.chats,
    records: () => live.chats?.records?.entries() ?? [],
    allowed,
    isMomoChat,
    changed: (chatId, noteId, send) => {
      broadcastAll('momoDraft:state', { chatId, noteId, send });
      broadcastAll('chats:changed', {
        id: chatId,
        chat: live.chats.get(chatId),
      });
    },
  });
  sender.settle();
  return { sender, off: registerDraftSendIpc(ipcMain, { sender, allowed }) };
}

module.exports = {
  openMomoDraftSend,
  registerDraftSendIpc,
  CHANNELS,
  NOT_ALLOWED,
};
