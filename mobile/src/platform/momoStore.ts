// Device-only storage for the MoMo memory copy: a SQLite row for the sealed bytes and a Keychain/Keystore key that never leaves the phone.
import { openDatabase } from './sqliteOpen';
import { sealedCrypto } from './sealedCrypto';
import { createMomoCache } from '../momo/cache';

const KEY = 'mobile-remote-momo-key';

export async function openMomoCache() {
  const db = await openDatabase('mobile-remote-momo.db');
  await db.execAsync('CREATE TABLE IF NOT EXISTS momo_memory (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT)');
  return createMomoCache({
    store: {
      read: async () => (await db.getFirstAsync<{ value: string | null }>('SELECT value FROM momo_memory WHERE id = 1'))?.value ?? null,
      write: async (value) => {
        await db.runAsync('INSERT OR REPLACE INTO momo_memory (id, value) VALUES (1, ?)', value);
      },
      clear: async () => {
        await db.runAsync('DELETE FROM momo_memory');
      },
    },
    crypto: sealedCrypto(KEY),
  });
}
