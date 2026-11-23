// Wires MoMo's channel registry (momo/channels.cjs) to a sealed file in MoMo's folder: the one place the storage seam gets its disk, its keychain and its clock. Reset MoMo erases the file (momoBackground.cjs, with the routines); the channels' chats go with the rest of MoMo's chats.
const path = require('node:path');
const { SealedJson } = require('../gateway/sealedFile.cjs');
const { createChannels, channelsShape } = require('../momo/channels.cjs');
const { createChannelChats } = require('../momo/channelChats.cjs');
const { registerChannelsIpc } = require('../momo/channelsIpc.cjs');
const { createEverything } = require('../momo/everything.cjs');
const { readMomoPrefs } = require('../../shared/momoPrefs.mjs');

const FILE = 'channels.json';

/**
 * @param {{ dir: string, safeStorage: any, now?: () => number }} o
 * @returns {{ channels: ReturnType<typeof createChannels>, erase: () => Promise<void> }}
 */
function openChannels({ dir, safeStorage, now = Date.now }) {
  const file = new SealedJson({ file: path.join(dir, FILE), safeStorage, now, shape: channelsShape });
  return { channels: createChannels({ storage: file, now }), erase: () => file.erase() };
}

/** Whether `momo.channels` is on now (read at every call, never cached). */
const channelsOn = (/** @type {() => any} */ readState) => readMomoPrefs(readState()?.prefs?.momo).channels === true;

/**
 * The context provider's `channel` option: the channel a chat is the journal of, with its instructions, while channels are on.
 * @param {ReturnType<typeof createChannels>} channels @param {() => boolean} enabled
 */
const channelContext = (channels, enabled) => (/** @type {string} */ chatId) => {
  if (enabled() !== true) return null;
  const c = channels.byChatId(chatId);
  return c ? { name: c.name, instructions: channels.instructionsOf(c.id) } : null;
};

/**
 * The channels' service and IPC, once the main chat exists: a channel's chat is made through it, and archived, deleted, stopped and told to the windows here.
 * @param {any} ipcMain
 * @param {{ store: { channels: ReturnType<typeof createChannels> }, mainChat: any, live: any, allowed: () => boolean, readState: () => any,
 *   broadcastAll: (channel: string, payload?: unknown) => void, history: () => { recent: (chatIds: string[], limit: number) => any } }} o
 *   history: MoMo's index of its chats (made after this, so read at each call)
 */
function registerMomoChannels(ipcMain, { store, mainChat, live, allowed, readState, broadcastAll, history }) {
  const channels = store.channels;
  const enabled = () => channelsOn(readState);
  const chats = createChannelChats({
    channels,
    mainChat,
    chats: live.chats,
    allowed,
    enabled,
    stop: (chatId) => live.controller?.stopChat(chatId),
    deleteChat: async (chatId) => {
      if (!live.chatDeletion) throw new Error("MoMo's chats can't be deleted before the chats are open");
      if (!live.chatDeletion.isDeleted(chatId)) await live.chatDeletion.delete(chatId);
      live.chats?.forgetDeleted(chatId);
    },
    changed: (chatId) => broadcastAll('chats:changed', { id: chatId, chat: live.chats.get(chatId) }),
  });
  const everything = createEverything({
    recent: (ids, limit) => history().recent(ids, limit),
    channels,
    mainChatId: () => mainChat.mainChatId(),
  });
  registerChannelsIpc(ipcMain, { channels, chats, everything, allowed, enabled, broadcast: (channel) => broadcastAll(channel) });
  return { registry: channels, chats, enabled };
}

module.exports = { openChannels, channelsOn, channelContext, registerMomoChannels, FILE };
