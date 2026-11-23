// What keeps running on this Mac when the app quits (H2): which chats run on the background Host, whether the one-line notice was shown once, and stopping those chats when the person chose "Quit and stop them".
const path = require('node:path');
const { readStoreFile, writeAtomic } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** The notice's own file in the user data folder: written once the quit sheet showed it. */
const NOTICE_FILE = 'host-local-quit-notice.json';

/**
 * @param {object} o
 * @param {string} o.dir the user data dir
 * @param {(chatId: string) => boolean} o.runsHere whether a chat runs on this Mac's background Host (host-ownership.json)
 * @param {(chatId: string) => Promise<unknown> | undefined} o.stopChat stops the turn of a chat on the background Host
 */
function createKeepsRunning({ dir, runsHere, stopChat }) {
  const file = path.join(dir, NOTICE_FILE);
  return {
    /** Whether the chat runs on this Mac's background Host, so quitting the app does not end its turn. @param {string} chatId */
    owns(chatId) {
      try {
        return runsHere(chatId);
      } catch (error) {
        noteIgnored('read where a chat runs for the quit sheet', error);
        return false;
      }
    },
    /** Whether the notice was shown before: after that the app quits without asking about these chats. */
    seen() {
      return readStoreFile(file, 'the quit notice').data?.seen === true;
    },
    markSeen() {
      try {
        writeAtomic(file, JSON.stringify({ seen: true }));
      } catch (error) {
        noteIgnored('remember the quit notice was shown', error);
      }
    },
    /** @param {string[]} chatIds */
    async stop(chatIds) {
      await Promise.all(
        chatIds.map((id) =>
          Promise.resolve()
            .then(() => stopChat(id))
            .catch((error) => noteIgnored('stop a chat on this Mac’s background Host before quitting', error)),
        ),
      );
    },
  };
}

module.exports = { createKeepsRunning, NOTICE_FILE };
