// Device storage for the sealed chat rows: a SQLite table of ciphertext and a Keychain/Keystore key that never leaves the phone.
import { openDatabase } from './sqliteOpen';
import { createChatCache } from '../presentation/chatCache';
import { createPageCache, lazyPageCache, withPages, type PagedChatCache } from '../remote/pageCache';
import { pageCacheOn } from '../remote/pageCacheFlag';
import { createListCache } from '../presentation/listCache';
import { createPictureCache } from '../presentation/pictureCache';
import { forgetSealedKey, hasSealedKey, sealedCrypto } from './sealedCrypto';
import { markerFor } from './installMarker';
import { PAGE_MAX_AGE_MS } from '../remote/pageCache';

async function openRowCache() {
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

/** The sealed older rows of each chat: its own table and its own device-only key, so it never races the other keys into existence. */
const PAGES_KEY = 'mobile-remote-chat-pages-key';
const install = markerFor('mopilot-saved-history.marker');
const dropped = markerFor('mopilot-saved-history.dropped');
export async function openPageCache() {
  const db = await openDatabase('mobile-remote-chats.db');
  await db.execAsync('CREATE TABLE IF NOT EXISTS chat_pages (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)');
  // the first launch since an install: whatever a backup restored here, and a key the Keychain kept through an uninstall, is not this install's; and a copy
  // whose key is gone cannot be read and is not written over as if it were empty
  await dropped.clear();
  const fresh = !(await install.present());
  if (fresh) await forgetSealedKey(PAGES_KEY);
  if (fresh || !(await hasSealedKey(PAGES_KEY))) await db.runAsync('DELETE FROM chat_pages');
  if (fresh) await install.set();
  // a chat not opened for as long as a copy is kept (a computer unpaired while the phone was off) is not kept longer
  await db.runAsync('DELETE FROM chat_pages WHERE at < ?', Date.now() - PAGE_MAX_AGE_MS);
  return createPageCache({
    store: {
      read: async (key) => (await db.getFirstAsync<{ value: string }>('SELECT value FROM chat_pages WHERE key = ?', key))?.value ?? null,
      write: async (key, value) => {
        await db.runAsync('INSERT OR REPLACE INTO chat_pages (key, value, at) VALUES (?, ?, ?)', key, value, Date.now());
      },
      remove: async (key) => {
        await db.runAsync('DELETE FROM chat_pages WHERE key = ?', key);
      },
      keys: async () => (await db.getAllAsync<{ key: string }>('SELECT key FROM chat_pages ORDER BY at ASC')).map((r) => r.key),
      clear: async () => {
        await db.runAsync('DELETE FROM chat_pages');
      },
    },
    crypto: sealedCrypto(PAGES_KEY),
  });
}

/**
 * What a build with the page cache left on the phone goes, once (a marker says it has): the table and the key, which nothing else would reach. It runs
 * beside the rows cache, never in front of it: a Keychain that does not answer (a locked device) fails it quietly and the next launch tries again.
 */
async function dropPagesOnce() {
  if (await dropped.present()) return;
  const db = await openDatabase('mobile-remote-chats.db');
  await db.execAsync('DROP TABLE IF EXISTS chat_pages');
  await forgetSealedKey(PAGES_KEY);
  await dropped.set();
}

/**
 * The sealed rows, with the sealed older pages beside them when this build keeps those. The rows are ready when they are: the page cache opens beside
 * them (its own table, key and install checks) and answers when it can; one that cannot be opened is not there for the session.
 */
export async function openChatCache(): Promise<PagedChatCache> {
  const rows = await openRowCache();
  if (!pageCacheOn()) {
    void dropPagesOnce().catch(() => undefined);
    return rows;
  }
  return withPages(rows, lazyPageCache(openPageCache()));
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
