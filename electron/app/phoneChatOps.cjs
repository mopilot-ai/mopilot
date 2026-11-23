// A queued follow-up taken back, or a chat renamed, archived or brought back, from a paired phone (electron/remote/methods/chatsManage.cjs), through the same main-process paths the session tools use: each harness's own rename and restore (app/sessionHost.cjs) and the app's archive (session/autoArchive.cjs archive), so it works on Codex, Claude Code and ACP chats with no window open; every window hears it (chats:changed).

const { removeQueuedForUser } = require('../session/orchestration/userRemoval.cjs');

/** @param {string} message */
const unavailable = (message) => new Error(message);

/** @param {{ live: any }} o main's late-bound services: sessionHost (sessionManagement.cjs), archiveChat (ipc/chats.cjs) */
function createPhoneChatOps({ live }) {
  /** The session host, once the session tools are registered. */
  const host = () => {
    if (!live.sessionHost) throw unavailable("Chats can't be changed from your phone right now. Try again in a moment.");
    return live.sessionHost;
  };
  /** The user's own queued message `id` of the chat (not another session's, a chat's, or one no human wrote), or null. @param {string} chatId @param {string} id */
  const users = (chatId, id) => {
    const queued = live.controller.state.has(chatId) && live.controller.state.get(chatId).queue.find((/** @type {any} */ q) => q.id === id);
    return queued && !queued.sideSession && !queued.peer && !queued.authored ? queued : null;
  };
  return {
    /**
     * Takes one of the user's own messages out of the chat's queue, as the app's Remove does; false when it already went out, is
     * gone, or is another session's or chat's (not a phone's to take).
     * @param {string} chatId @param {string} id
     */
    unqueue(chatId, id) {
      if (!users(chatId, id)) return false;
      // a message kept for a machine's Host lives in the Mac's outbox as well as in the queue the phone sees: the app's Remove asks it first
      const outbox = live.remoteSend?.()?.remove(chatId, id);
      return typeof outbox === 'boolean' ? outbox : removeQueuedForUser(live, chatId, id);
    },
    /**
     * Sends a message the machine's Host refused (or has not yet been sent) again, as the app's Retry on its row does: the Mac's answer, or null for a message
     * that is not in its outbox (one of this Mac's own, or already gone).
     * @param {string} chatId @param {string} id
     */
    async requeue(chatId, id) {
      return users(chatId, id) ? ((await live.remoteSend?.()?.sendNow(chatId, id)) ?? null) : null;
    },
    /** Names the chat on its own harness. @param {string} chatId @param {string} title */
    async renameChat(chatId, title) {
      await host().setTitle(chatId, title);
    },
    /** Archives the chat as the sidebar does, or brings it back. @param {string} chatId @param {boolean} archived */
    async archiveChat(chatId, archived) {
      if (!archived) return void (await host().unarchive(chatId));
      if (live.archiveChat?.(chatId) !== true) throw unavailable("That chat couldn't be archived.");
    },
  };
}

module.exports = { createPhoneChatOps };
