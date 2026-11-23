// Reset MoMo's chats (#2291), the 'chats' store electron/app/momo.cjs registers: every MoMo chat deleted through the app's own deletion, one that fails never keeping the rest from going, a chat its harness no longer has counted as deleted (session/chatDeletion.cjs), and each deleted chat's record taken off the disk; MoMo's workspace and its main chat's state go once no chat is left.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { momoWorkspace } = require('./stores.cjs');

/** How often the chats are read again for one made while Reset ran (a main chat a start had under way). */
const PASSES = 3;

/**
 * Stops each chat's turn and deletes the chat, reading MoMo's chats again until no new one is found; throws, naming how
 * many, when any is left.
 * @param {{ live: any, ids: () => string[], clear: (id: string) => void, dir: string, mainChat: { savedId: unknown } }} o
 */
async function resetMomoChats({ live, ids, clear, dir, mainChat }) {
  const deletion = live.chatDeletion;
  if (!deletion) throw new Error("MoMo's chats can't be deleted before the chats are open");
  /** @type {Set<string>} */
  const seen = new Set();
  let left = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const fresh = ids().filter((id) => !seen.has(id));
    if (!fresh.length) break;
    for (const id of fresh) seen.add(id);
    left += await deleteEach(live, fresh, clear);
  }
  // the main chat is read again from what is left
  mainChat.savedId = undefined;
  if (left) throw new Error(`${left} of MoMo's chats couldn't be deleted`);
  fs.rmSync(path.join(dir, 'state.json'), { force: true });
  fs.rmSync(momoWorkspace(dir), { recursive: true, force: true });
}

/**
 * Deletes each chat, one that fails never stopping the rest; resolves how many are left.
 * @param {any} live @param {string[]} chats @param {(id: string) => void} clear
 */
async function deleteEach(live, chats, clear) {
  let left = 0;
  for (const id of chats) {
    clear(id);
    try {
      if (!live.chatDeletion.isDeleted(id)) {
        // a turn still running ends first, so nothing it writes outlives its chat
        await Promise.resolve()
          .then(() => live.controller?.stopChat(id))
          .catch((error) => noteIgnored("stop a MoMo chat's turn for Reset", error));
        await live.chatDeletion.delete(id);
      }
      // no restart reads it as MoMo's again
      live.chats?.forgetDeleted(id);
    } catch (error) {
      left++;
      noteIgnored('delete a MoMo chat for Reset', error);
    }
  }
  return left;
}

module.exports = { resetMomoChats };
