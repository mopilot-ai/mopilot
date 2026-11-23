// MoMo's drafts in main (A3): the momo_draft tool (momo/draftTools.cjs) over the chat store, and the one IPC a draft card has: momoDraft:openInMail hands the card's words to the user's own mail app as a `mailto:` link built here from the checked draft (shared/momoDraft.mjs), never one the window names, so no other scheme or address opens and a draft too long for a link is refused. Nothing here sends: the link only opens a compose window the user sends from, or doesn't.
const { registerDraftTools } = require('../momo/draftTools.cjs');
const { readDraft, mailtoOf, isMailto } = require('../../shared/momoDraft.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** The refusal the other MoMo handlers give while MoMo is not allowed. */
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
const CHANNELS = Object.freeze(['momoDraft:openInMail']);
const NO_MAIL = 'Couldn’t open a mail app.';

/**
 * Hands `url` to the system only when it is a mail link: the allowlist in front of the one call that opens anything.
 * @param {string} url @param {(url: string) => Promise<unknown> | unknown} openExternal
 */
async function openMailLink(url, openExternal) {
  if (!isMailto(url)) return { ok: false, reason: 'unavailable', error: NO_MAIL };
  try {
    await openExternal(url);
    return { ok: true };
  } catch (error) {
    noteIgnored('open a MoMo draft in the mail app', error);
    return { ok: false, reason: 'no_mail_app', error: NO_MAIL };
  }
}

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ openExternal: (url: string) => Promise<unknown> | unknown, allowed: () => boolean }} o
 * @returns {() => void} removes the handler
 */
function registerDraftIpc(ipcMain, { openExternal, allowed }) {
  ipcMain.handle('momoDraft:openInMail', async (_e, input) => {
    if (allowed() !== true) return NOT_ALLOWED;
    const read = readDraft(input);
    if (!read.ok) return { ok: false, reason: read.reason, error: read.why };
    const link = mailtoOf(read.draft);
    if (!link.ok) return { ok: false, reason: link.reason, error: link.why };
    return openMailLink(link.url, openExternal);
  });
  return () => {
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

/**
 * @param {{ ipcMain: Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>, live: any, shell: { openExternal: (url: string) => Promise<void> },
 *   broadcastAll: (channel: string, payload?: unknown) => void, allowed: () => boolean, isMomoChat: (chatId: string) => boolean,
 *   owner: (ctx: any) => string | null, passChat: (chatId: string) => boolean }} o
 */
function openMomoDrafts({ ipcMain, live, shell, broadcastAll, allowed, isMomoChat, owner, passChat }) {
  registerDraftIpc(ipcMain, { openExternal: (url) => shell.openExternal(url), allowed });
  if (!live.capabilities) return;
  registerDraftTools(live.capabilities, {
    chats: live.chats,
    turnOf: (chatId) => live.sessions?.get(chatId)?.activeTurn?.id ?? null,
    changed: (id, chat) => broadcastAll('chats:changed', { id, chat }),
    allowed,
    isMomoChat,
    owner,
    passChat,
  });
}

module.exports = { openMomoDrafts, registerDraftIpc, openMailLink, CHANNELS, NOT_ALLOWED, NO_MAIL };
