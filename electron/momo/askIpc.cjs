// Ask MoMo in Quick Chat over IPC (#2139): the floating window's MoMo target reads MoMo's main chat and sends to it, and only to it; each call is refused unless it comes from Quick Chat while MoMo is allowed. Main picks the chat (the main chat service), so the window can't name another, and Quick Chat's own saved chat and draft are never MoMo's. Registered with main's startup (not from electron/app/ipc/), once MoMo's main chat service is made.

const { identityKey } = require('../../shared/identityKey.mjs');
const { acceptSendReceipt } = require('../../shared/sendReceipt.mjs');
const { sendOnce } = require('../../shared/sendOnce.mjs');

/** A refusal with the code the window tells apart. */
const refused = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const NOT_ALLOWED = 'MoMo is not available for this account.';
const NOT_QUICK_CHAT = 'Only Quick Chat can ask MoMo here.';
/** Sends remembered for a retry: the oldest goes past this many. */
const KEEP = 256;

/**
 * @param {{ handle: (channel: string, fn: (event: any, ...args: any[]) => unknown) => void }} ipcMain
 * @param {object} o
 * @param {(sender: unknown) => boolean} o.isQuickChat the call came from the Quick Chat window (isQuickChatSender)
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {() => Promise<{ chatId: string }>} o.mainChat MoMo's main chat, made when there is none (service.ensureMainChat)
 * @param {() => Promise<unknown>} o.ready the app window is ready (readyMainWindow), as Quick Chat's own sends wait for
 * @param {(chatId: string, item: object, senderId: number) => unknown} o.send a user turn to the chat (the ChatController's send); answers a send receipt
 * @param {() => unknown} o.openMomo shows MoMo's chat in the app window and hides Quick Chat
 */
function registerMomoAskIpc(ipcMain, { isQuickChat, allowed, mainChat, ready, send, openMomo }) {
  /** Sends by chat and request id: a retry of one in flight or accepted answers it again; a failed or refused one (acceptSendReceipt throws) is sent again. */
  const once = sendOnce({ keep: KEEP });
  const sendOnceFor = (/** @type {string} */ chatId, /** @type {{ id: string }} */ item, /** @type {() => unknown} */ dispatch) =>
    once(identityKey(chatId, item.id), () => Promise.resolve(dispatch()).then((receipt) => acceptSendReceipt(receipt)));
  /** Quick Chat while MoMo is on, checked again after every wait. */
  const check = (/** @type {any} */ e) => {
    if (!isQuickChat(e.sender)) throw refused(NOT_QUICK_CHAT, 'not_quick_chat');
    if (!allowed()) throw refused(NOT_ALLOWED, 'not_allowed');
  };
  const handle = (/** @type {string} */ channel, /** @type {(e: any, ...args: any[]) => unknown} */ fn) =>
    ipcMain.handle(channel, async (e, ...args) => {
      try {
        check(e);
        return { value: await fn(e, ...args) };
      } catch (err) {
        return { error: { message: String(err?.message ?? err), code: err?.code ?? null } };
      }
    });
  handle('momoAsk:chat', async (e) => {
    const { chatId } = await mainChat();
    check(e);
    return { chatId };
  });
  handle('momoAsk:send', async (e, input) => {
    const text = typeof input?.text === 'string' ? input.text.trim() : '';
    if (!text) throw refused('Nothing to send.', 'bad_args');
    if (typeof input.id !== 'string' || !input.id || input.id.length > 128) throw refused('Invalid request.', 'bad_args');
    const item = {
      id: input.id,
      text,
      attachments: [],
      opts: { human: true },
      followUp: input.followUp === 'steer' ? 'steer' : 'queue',
    };
    await ready();
    const { chatId } = await mainChat();
    // MoMo turned off or Quick Chat closed while the app window or the main chat was being made: nothing is sent
    check(e);
    return { chatId, note: await sendOnceFor(chatId, item, () => send(chatId, item, e.sender.id)) };
  });
  handle('momoAsk:open', async () => {
    await openMomo();
  });
}

module.exports = { registerMomoAskIpc, KEEP };
