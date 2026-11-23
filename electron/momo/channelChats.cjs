// The chats behind MoMo's channels (A2): each channel's journal is a MoMo chat tagged meta.momo = 'channel:<id>' (shared/momoChat.mjs), made on the first open with the brain main's chat has (MoMo's one brain, no channel setting), in MoMo's own workspace through the main chat service's startBackground. So it is MoMo's in every way (its tool set, the trust gate, the sentinel, the audit log, no list of coding chats shows it) and is kept on the brain like main: a brain change reaches it through the same pending switch or picks, and a chat whose session is gone, or that a harness switch can't carry, is replaced by a new one (the old one stays MoMo's, hidden, as 'previous'). Channel operations (open, archive, delete) run in turn with the brain changes, so they never overlap them. Everything refuses while MoMo isn't allowed or channels are off.
const { channelTag, momoChannelIdOf, isMomoMeta } = require('../../shared/momoChat.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { pinModel } = require('./brainModel.cjs');
const { failure, notAllowed } = require('./mainChat.cjs');

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./channels.cjs').createChannels>} o.channels the registry
 * @param {InstanceType<typeof import('./mainChat.cjs').MomoMainChat>} o.mainChat the main chat service (the brain, the picks, the serial queue)
 * @param {any} o.chats ChatsStore: records, patchMeta(), isDeleted()
 * @param {() => boolean} o.allowed MoMo is on for the signed-in account
 * @param {() => boolean} o.enabled prefs.momo.channels is on
 * @param {(chatId: string) => unknown} o.stop ends the chat's turn
 * @param {(chatId: string) => Promise<unknown>} o.deleteChat the app's own chat deletion
 * @param {(chatId: string) => void} o.changed every window reads the chat's meta again
 */
function createChannelChats({ channels, mainChat, chats, allowed, enabled, stop, deleteChat, changed }) {
  const refuse = () => {
    if (allowed() !== true) throw notAllowed();
    if (enabled() !== true) throw failure('unavailable', 'Channels are off.');
  };
  /** A chat that can go on being channel `id`'s journal: there, not deleted, not archived, tagged for it. */
  const usable = (/** @type {string | null} */ chatId, /** @type {string} */ id) => {
    if (!chatId || chats.isDeleted?.(chatId)) return false;
    const meta = chats.records.get(chatId)?.meta;
    return isMomoMeta(meta) && momoChannelIdOf(meta) === id && meta.archived == null;
  };

  /** The journal brought to the brain saved now, or replaced; resolves where it stands. */
  async function keep(/** @type {string} */ id, /** @type {string} */ chatId) {
    if (!mainChat.busy(chatId) && (await mainChat.gone(chatId)))
      return replace(id, chatId, 'MoMo started a new conversation here: the last one could not be reopened.');
    const brain = mainChat.brain();
    if (!brain) return { chatId, warning: null };
    if (mainChat.planFor(chatId, brain) === 'now') {
      if (pinModel(chats, chatId, brain)) changed(chatId);
      return { chatId, warning: null };
    }
    const r = mainChat.reconcile(chatId, brain);
    if (r.applied !== 'newChat') return { chatId, warning: r.warning };
    if (mainChat.busy(chatId)) return { chatId, warning: 'MoMo moves to its new brain once this chat is free.' };
    return replace(id, chatId, null);
  }

  /** A new journal on the brain; the old one stays MoMo's (hidden) as 'previous'. */
  async function replace(/** @type {string} */ id, /** @type {string} */ oldId, /** @type {string | null} */ note) {
    const made = await make(id);
    mainChat.retire(oldId);
    return { ...made, warning: [made.warning, note].filter(Boolean).join(' ') || null };
  }

  async function make(/** @type {string} */ id) {
    const brain = await mainChat.brainOrDefault();
    const chatId = await mainChat.startBackground(brain, { momo: channelTag(id) });
    try {
      await channels.linkChat(id, chatId);
    } catch (e) {
      // the channel went (archived or deleted) while the chat started: it is never anyone's journal
      mainChat.retire(chatId);
      throw e;
    }
    return { chatId, warning: null };
  }

  /** In-flight opens by channel: concurrent calls make one chat. */
  const opening = new Map();
  return {
    /**
     * Channel `id`'s journal: made when there is none, else brought to the brain. Resolves its id and a warning when
     * part of the brain couldn't be applied (the chat goes on).
     * @param {unknown} id @returns {Promise<{ chatId: string, warning: string | null }>}
     */
    async ensure(id) {
      refuse();
      const channel = channels.get(id);
      if (!channel) throw failure('gone', 'That channel isn’t there any more.');
      const key = channel.id;
      if (!opening.has(key))
        opening.set(
          key,
          mainChat
            .serial(async () => {
              // turned off, archived or deleted while this waited for the operation before it
              refuse();
              const chatId = channels.chatIdOf(key);
              return usable(chatId, key) ? keep(key, /** @type {string} */ (chatId)) : make(key);
            })
            .finally(() => opening.delete(key)),
        );
      return opening.get(key);
    },
    /** The journal of an open channel without making it (null: no chat yet); throws for an unknown or archived channel. */
    chatIdOf(/** @type {unknown} */ id) {
      refuse();
      if (!channels.get(id)) throw failure('gone', 'That channel isn’t there any more.');
      const chatId = channels.chatIdOf(id);
      return usable(chatId, /** @type {string} */ (id)) ? chatId : null;
    },
    /**
     * Archive: the channel leaves the rail and its turn ends; its journal stays (hidden, MoMo's) and so does everything
     * MoMo remembered: memory is MoMo's, not the channel's.
     */
    archive(/** @type {unknown} */ id) {
      refuse();
      return mainChat.serial(async () => {
        refuse();
        const row = await channels.archive(id);
        if (row.chatId) await Promise.resolve(stop(row.chatId)).catch((e) => noteIgnored("stop a channel's turn", e));
        return { id: row.id };
      });
    },
    /** Undo of an archive: the channel is back on the rail; its journal never left. */
    restore(/** @type {unknown} */ id) {
      refuse();
      return mainChat.serial(async () => {
        refuse();
        return { channel: await channels.restore(id) };
      });
    },
    /** Delete: the channel and its journal go; memory stays. A journal that can't be deleted keeps the channel, so nothing is half done. */
    remove(/** @type {unknown} */ id) {
      refuse();
      return mainChat.serial(async () => {
        refuse();
        if (!channels.get(id)) throw failure('gone', 'That channel isn’t there any more.');
        const chatId = channels.chatIdOf(id);
        if (chatId) {
          await Promise.resolve(stop(chatId)).catch((e) => noteIgnored("stop a channel's turn", e));
          // the registry still names the channel while its journal is deleted: a failure loses nothing
          await deleteChat(chatId);
        }
        return { id: (await channels.remove(id)).id };
      });
    },
  };
}

module.exports = { createChannelChats };
