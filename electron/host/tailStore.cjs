// The tail a returning Host still held for a chat that was continued without it, kept as read-only history beside the app's data (docs: design/host/index.html, package 3.1). One record per chat and Host in one file; a repeat of the same tail replaces it, so merging twice changes nothing.
const { writeAtomic, readStoreFile } = require('../platform/fsutil.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

const valid = (/** @type {unknown} */ v) =>
  isJsonRecord(v) &&
  Object.values(/** @type {Record<string, any>} */ (v)).every(
    (t) => isJsonRecord(t) && typeof t.chatId === 'string' && typeof t.hostId === 'string' && Array.isArray(t.items),
  );

/** One record's key: the pair as a structured value, so ids with delimiters cannot collide. @param {string} chatId @param {string} hostId */
const keyOf = (chatId, hostId) => JSON.stringify([chatId, hostId]);

/** @param {string} file */
function createTailStore(file) {
  /** The records on disk; a file that cannot be read keeps its copy and reads as no tails (reported by the reader). @returns {Record<string, { chatId: string, hostId: string, items: object[] }>} */
  const load = () => readStoreFile(file, 'the tails of continued chats', valid).data ?? {};
  return {
    /** @param {{ chatId: string, hostId: string, items: object[] }} t */
    merge({ chatId, hostId, items }) {
      const { data, error } = readStoreFile(file, 'the tails of continued chats', valid);
      // an unreadable file is never overwritten by one record: the caller keeps the lost-host record and tries again
      if (error) throw error;
      writeAtomic(file, JSON.stringify({ ...(data ?? {}), [keyOf(chatId, hostId)]: { chatId, hostId, items } }));
    },
    /** The tails kept for the chat, one per Host. @param {string} chatId */
    read(chatId) {
      return Object.values(load())
        .filter((t) => t.chatId === chatId)
        .map((t) => ({ hostId: t.hostId, items: t.items }));
    },
  };
}

module.exports = { createTailStore };
