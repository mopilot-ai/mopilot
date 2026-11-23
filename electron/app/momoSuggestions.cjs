// Wires MoMo's suggestions (momo/suggestions.cjs) to a sealed file in MoMo's folder, and gives Start its send: the one place the storage seam gets its disk, its keychain and its clock, and the one place a suggestion's first step becomes a message. Start is the user's act, so the message goes into MoMo's chat for the suggestion's channel through the chat's own send as the user's input (opts.human), exactly as a typed one: the trust gate and the sentinel see it as they see any message. Reset MoMo erases the file (momoBackground.cjs, with the routines).
const path = require('node:path');
const crypto = require('node:crypto');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { createSuggestions, suggestionsShape, SuggestionError } = require('../momo/suggestions.cjs');
const { acceptSendReceipt } = require('../../shared/sendReceipt.mjs');
const { isMomoPaused, readMomoPrefs } = require('../../shared/momoPrefs.mjs');
const { isMomoDataMeta } = require('../../shared/momoChat.mjs');
const { registerSuggestionsIpc } = require('../momo/suggestionsIpc.cjs');
const { registerSuggestionTools } = require('../momo/suggestionTools.cjs');

const FILE = 'suggestions.json';
const PAUSED = 'MoMo is paused. Resume it first.';

/**
 * @param {{ dir: string, safeStorage: any, now?: () => number }} o
 * @returns {{ store: ReturnType<typeof createSuggestions>, erase: () => Promise<void> }}
 */
function openSuggestions({ dir, safeStorage, now = Date.now }) {
  const file = new SealedJson({ file: path.join(dir, FILE), safeStorage, now, shape: suggestionsShape });
  return { store: createSuggestions({ storage: file, now }), erase: () => file.erase() };
}

/**
 * Start's send: the first step into the chat of the suggestion's channel.
 * @param {object} o
 * @param {{ ensureMainChat: () => Promise<{ chatId: string }> }} o.mainChat
 * @param {(channel: string) => Promise<string | null> | string | null} [o.chatOfChannel] the chat a channel id names (A2's channel chats: it makes the chat when there is none), null or a refusal for one that is gone
 * @param {{ send: (chatId: string, item: object, origin: null, wait: true) => Promise<unknown> }} o.controller
 * @param {() => boolean} o.paused whether MoMo is paused: a pause holds what MoMo starts, and Start is held with it so nothing is dropped
 * @param {() => string} [o.newId]
 * @returns {(suggestion: { channel: string }, text: string) => Promise<void>}
 */
function createStarter({ mainChat, chatOfChannel = () => null, controller, paused, newId = () => crypto.randomUUID() }) {
  return async (suggestion, text) => {
    if (paused()) throw new SuggestionError(PAUSED, 'bad_args');
    /** @type {string | null} */
    let chatId;
    if (suggestion.channel === 'main') chatId = (await mainChat.ensureMainChat()).chatId;
    else
      try {
        // the channel's own chat, made when it has none; a channel archived or deleted since is gone
        chatId = await chatOfChannel(suggestion.channel);
      } catch {
        chatId = null;
      }
    if (!chatId) throw new SuggestionError('That channel is gone.', 'gone');
    const error = acceptSendReceipt(
      await controller.send(chatId, { id: newId(), text, attachments: [], opts: { human: true }, followUp: 'queue' }, null, true),
    );
    if (error) throw new Error(error);
  };
}

/**
 * The suggestions' IPC and MoMo's tool, behind their own flag (`prefs.momo.suggestions`, off by default, whatever the Tasks panel is).
 * @param {{ core: any, live: any, ipcMain: any, store: ReturnType<typeof createSuggestions>, allowed: () => boolean, momoPrefs: () => any,
 *   broadcast: (channel: string) => void, meta: (chatId: string) => any }} d
 */
function registerMomoSuggestions({ core, live, ipcMain, store, allowed, momoPrefs, broadcast, meta }) {
  const enabled = () => readMomoPrefs(momoPrefs()).suggestions === true;
  registerSuggestionsIpc(ipcMain, {
    store,
    allowed,
    enabled,
    start: createStarter({
      mainChat: core.mainChat,
      controller: { send: (/** @type {any[]} */ ...a) => live.controller.send(...a) },
      paused: () => isMomoPaused(momoPrefs()),
      chatOfChannel: async (id) => (await core.channelsApi.chats.ensure(id)).chatId,
    }),
    broadcast,
  });
  if (live.capabilities)
    registerSuggestionTools(live.capabilities, {
      store,
      allowed,
      enabled,
      isMomoChat: core.isMomoChat,
      owner: core.owner,
      passChat: (chatId) => isMomoDataMeta(meta(chatId)),
      changed: () => broadcast('momoSuggestions:changed'),
      channelOpen: (id) => core.channelsApi.registry.get(id) !== null,
    });
}

module.exports = { openSuggestions, createStarter, registerMomoSuggestions, FILE, PAUSED };
