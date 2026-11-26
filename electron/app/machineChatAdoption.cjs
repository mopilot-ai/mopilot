// What taking in a chat only a machine lists does to this app's records, and what undoes it (electron/host/adoptMachineChat.cjs): the chat is bound to its machine and folder with the epoch the machine holds and marked as taken in, on the binding itself so it holds after a restart; followed; or, if it never reached a window, released. A chat taken in reads the Host's epoch again when its row is reopened and when the Host refuses a message for it.
const { appChatId } = require('../../shared/host/chatIds.mjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {() => { bind: (chatId: string, at: { hostId: string, folder: string }) => void }} o.folders
 * @param {() => { get: () => { follow: (chatId: string) => Promise<unknown> } | null | undefined, release: (chatId: string) => void, setEpoch: (chatId: string, epoch: number) => void, markTakenIn: (chatId: string, epoch?: number) => void, takenIn: (chatId: string) => boolean, takenInChats: () => { chatId: string, at: number }[], pendingDeletions: () => { hostId: string, chatId: string }[] }} o.chats the machine chats service
 * @param {{ live?: { hostOwnership?: { get: (chatId: string) => { hostId: string, epoch?: number } }, remoteSend?: { rebase: (chatId: string) => Promise<unknown> | unknown } } } | undefined} o.deps main's live services (the ownership side map, the send path)
 * @param {() => { chatIndex: () => { machineId: string, rows: { chatId: string, epoch?: number }[] }[] }} o.service the machines service: what each machine lists
 */
/** How long a taken-in binding with no record is left alone. */
const STALE_MS = 7 * 24 * 3600 * 1000;

function machineChatAdoption({ folders, chats, deps, service }) {
  /** Chats the Host refused for their epoch while the list showed no newer one yet: tried again when the list changes. @type {Set<string>} */
  const waiting = new Set();
  /** The epoch the machine's list holds for a chat bound here, when it is newer than the one the chat is bound with. @param {string} chatId @returns {number | null} */
  function newerEpoch(chatId) {
    const owner = deps?.live?.hostOwnership?.get(chatId);
    if (!owner || owner.hostId === 'local') return null;
    const listed = service()
      .chatIndex()
      .find((e) => e.machineId === owner.hostId)
      ?.rows.find((r) => appChatId(r.chatId) === chatId);
    return listed && Number.isSafeInteger(listed.epoch) && /** @type {number} */ (listed.epoch) > (owner.epoch ?? 0)
      ? /** @type {number} */ (listed.epoch)
      : null;
  }
  return {
    /** A chat a machine ran on its own (a scheduled run) is listed and followed like one started here. @param {string} chatId @param {{ hostId: string, folder: string }} at */
    adopt: async (chatId, at) => {
      folders().bind(chatId, at);
      await chats().get()?.follow(chatId);
    },
    /** A chat taken in from the machine's list: bound, marked on its binding, followed. @param {string} chatId @param {{ hostId: string, folder: string, epoch?: number }} at `epoch`: the one the machine's Host holds for the chat, which the first message must carry */
    takeIn: async (chatId, at) => {
      folders().bind(chatId, at);
      chats().markTakenIn(chatId, at.epoch);
      await chats().get()?.follow(chatId);
    },
    /** @param {string} chatId */
    release: (chatId) => {
      waiting.delete(chatId);
      chats().release(chatId);
    },
    /** The epoch of a chat bound here is read again (never a mark that it was taken in). @param {string} chatId @param {number} epoch */
    setEpoch: (chatId, epoch) => chats().setEpoch(chatId, epoch),
    /** Whether the chat was taken in from a machine's list, as its binding says (also after a restart). @param {string} chatId */
    takenIn: (chatId) => chats().takenIn(chatId),
    /**
     * A message for a chat taken in was refused for its epoch: whether the list holds a newer one than the chat is bound with (it is bound with it now). When the list does not yet, the chat waits for the list to change (`indexChanged`).
     * @param {string} chatId
     */
    refreshEpoch(chatId) {
      if (!chats().takenIn(chatId)) return false;
      const epoch = newerEpoch(chatId);
      if (epoch === null) {
        waiting.add(chatId);
        return false;
      }
      chats().setEpoch(chatId, epoch);
      return true;
    },
    /** The deletions still waiting for their machine: it lists those chats until it is told, and the windows are not shown them. */
    pendingDeletions: () => chats().pendingDeletions(),
    /** The list changed: a chat that waited for a newer epoch gets it and its messages go. */
    indexChanged() {
      for (const chatId of [...waiting]) {
        const epoch = newerEpoch(chatId);
        if (epoch === null) continue;
        waiting.delete(chatId);
        chats().setEpoch(chatId, epoch);
        void Promise.resolve(deps?.live?.remoteSend?.rebase(chatId)).catch((error) =>
          noteIgnored('send what waited for a newer epoch', error),
        );
      }
    },
    /**
     * At the first read of the list in a run: a binding taken in more than a week ago that no window gave a record, and no message waits for, is let go (the chat is a row of its machine again). A newer one is never judged: its record may only come with its first message, and a chat reopened from its machine's row comes back whole.
     * @param {(chatId: string) => boolean} keep whether this Mac has a record of the chat or a message waiting for it @param {number} [now]
     */
    sweep(keep, now = Date.now()) {
      for (const { chatId, at } of chats().takenInChats()) if (now - at > STALE_MS && !keep(chatId)) chats().release(chatId);
    },
  };
}

module.exports = { machineChatAdoption };
