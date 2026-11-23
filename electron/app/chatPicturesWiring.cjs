// Wires the sent pictures' keeper (platform/chatPictures.cjs): the controller keeps a message's pasted pictures before any adapter sees them, a deleted chat's folder goes, and a Codex fork of a chat shares its pictures until it is deleted too (#5183).
const path = require('node:path');
const { createChatPictures } = require('../platform/chatPictures.cjs');
const { addHook } = require('../session/hookChain.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { toRendererSegment } = require('../platform/chats.cjs');

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: controller, chats, codex, chatDeletion
 * @param {string} o.userData the app's data folder
 */
function wireChatPictures({ live, userData }) {
  // a missing service would leave pictures never removed or forks never linked: startup opens the chat deletion and the threads first
  if (!live.codex || !live.chatDeletion) throw new Error('Chat pictures need the thread fork hook and the chat deletion opened first');
  const pictures = createChatPictures({ root: () => path.join(userData, 'chat-pictures') });
  live.controller.pictures = pictures;
  // a chat's pictures are filed under its id; a fork's parent thread may be a later segment of a chat that switched harness
  const chatOf = (/** @type {string} */ thread) => {
    for (const [id, record] of live.chats.records)
      if (!isMomoMeta(record.meta) && record.segments.some((/** @type {any} */ s) => toRendererSegment(s).nativeId === thread)) return id;
    return thread;
  };
  // the parent's own pictures, and those of any chat the parent is itself a fork of (a fork of a fork names the first chat's paths)
  addHook(live.codex, 'onFork', (/** @type {string} */ parent, /** @type {string} */ fork) =>
    pictures.share(chatOf(parent), fork, [parent, chatOf(parent)]),
  );
  addHook(live.chatDeletion, 'onDeleted', (/** @type {{ chatId: string, nativeKeys: string[] }} */ receipt) => {
    // the chat is deleted either way: pictures that can't be removed now do not fail the deletion
    pictures
      .remove(receipt.chatId, [receipt.chatId, ...receipt.nativeKeys])
      .catch((error) => noteIgnored("remove a deleted chat's pictures", error));
  });
  return pictures;
}

module.exports = { wireChatPictures };
