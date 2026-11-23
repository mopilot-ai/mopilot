// Device storage for the sealed chat rows: a SQLite table of ciphertext and a Keychain/Keystore key that never leaves the phone.
import { openDatabase } from './sqliteOpen';
import { createChatCache } from '../presentation/chatCache';
import { createListCache } from '../presentation/listCache';
import { createPictureCache } from '../presentation/pictureCache';
import { sealedCrypto } from './sealedCrypto';

export async function openChatCache() {
  const db = await openDatabase('mobile-remote-chats.db');
  await db.execAsync('CREATE TABLE IF NOT EXISTS chat_rows (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)');
  return createChatCache({
    store: {
      read: async (key) => (await db.getFirstAsync<{ value: string }>('SELECT value FROM chat_rows WHERE key = ?', key))?.value ?? null,
      write: async (key, value) => {
        await db.runAsync('INSERT OR REPLACE INTO chat_rows (key, value, at) VALUES (?, ?, ?)', key, value, Date.now());
      },
      remove: async (key) => {
        await db.runAsync('DELETE FROM chat_rows WHERE key = ?', key);
      },
      keys: async () => (await db.getAllAsync<{ key: string }>('SELECT key FROM chat_rows ORDER BY at ASC')).map((r) => r.key),
      clear: async () => {
        await db.runAsync('DELETE FROM chat_rows');
      },
    },
    crypto: sealedCrypto('mobile-remote-chat-rows-key'),
  });
}

/** The sealed last chat list per computer: its own table and its own key, so it never races the rows' key into existence. */
export async function openListCache() {
  const db = await openDatabase('mobile-remote-chats.db');
  await db.execAsync('CREATE TABLE IF NOT EXISTS chat_lists (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)');
  return createListCache({
    store: {
      read: async (key) => (await db.getFirstAsync<{ value: string }>('SELECT value FROM chat_lists WHERE key = ?', key))?.value ?? null,
      write: async (key, value) => {
        await db.runAsync('INSERT OR REPLACE INTO chat_lists (key, value, at) VALUES (?, ?, ?)', key, value, Date.now());
      },
      remove: async (key) => {
        await db.runAsync('DELETE FROM chat_lists WHERE key = ?', key);
      },
      keys: async () => (await db.getAllAsync<{ key: string }>('SELECT key FROM chat_lists ORDER BY at ASC')).map((r) => r.key),
      clear: async () => {
        await db.runAsync('DELETE FROM chat_lists');
      },
    },
    crypto: sealedCrypto('mobile-remote-chat-list-key'),
  });
}

/** The sealed thumbnails of attached pictures: its own table and key, so it never races the rows' or the lists' key into existence. */
export async function openPictureCache() {
  const db = await openDatabase('mobile-remote-chats.db');
  await db.execAsync('CREATE TABLE IF NOT EXISTS chat_pictures (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)');
  return createPictureCache({
    store: {
      read: async (key) => (await db.getFirstAsync<{ value: string }>('SELECT value FROM chat_pictures WHERE key = ?', key))?.value ?? null,
      write: async (key, value) => {
        await db.runAsync('INSERT OR REPLACE INTO chat_pictures (key, value, at) VALUES (?, ?, ?)', key, value, Date.now());
      },
      remove: async (key) => {
        await db.runAsync('DELETE FROM chat_pictures WHERE key = ?', key);
      },
      keys: async () => (await db.getAllAsync<{ key: string }>('SELECT key FROM chat_pictures ORDER BY at ASC')).map((r) => r.key),
      clear: async () => {
        await db.runAsync('DELETE FROM chat_pictures');
      },
    },
    crypto: sealedCrypto('mobile-remote-chat-pictures-key'),
  });
}
