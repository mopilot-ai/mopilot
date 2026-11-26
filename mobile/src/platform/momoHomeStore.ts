// Device-only storage for MoMo's home copy: a SQLite row for the sealed bytes and a Keychain/Keystore key that never leaves the phone (its own key, apart from MoMo's memory copy). Nothing is opened until MoMo's home screens ask: a marker in the keychain says whether anything was ever kept, so launch costs one keychain read.
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { createHomeCache } from '../momoPhone/homeCache';
import { openDatabase } from './sqliteOpen';
import { sealedCrypto } from './sealedCrypto';

const KEY = 'mobile-remote-momo-home-key';
const USED = 'mobile-remote-momo-home-used';

export async function openMomoHomeCache() {
  const db = await openDatabase('mobile-remote-momo-home.db');
  await db.execAsync('CREATE TABLE IF NOT EXISTS momo_home (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT)');
  return createHomeCache({
    store: {
      read: async () => (await db.getFirstAsync<{ value: string | null }>('SELECT value FROM momo_home WHERE id = 1'))?.value ?? null,
      write: async (value) => {
        await db.runAsync('INSERT OR REPLACE INTO momo_home (id, value) VALUES (1, ?)', value);
      },
      clear: async () => {
        await db.runAsync('DELETE FROM momo_home');
      },
    },
    crypto: sealedCrypto(KEY),
  });
}

/** Whether anything was ever kept on this phone for MoMo's home (a phone where nobody uses it never opens the database). */
export const momoHomeWasUsed = async (): Promise<boolean> => (await keychain(SecureStore.getItemAsync(USED))) === '1';

/** Notes that something is kept, so the next launch checks it against the accounts and computers. */
export const markMomoHomeUsed = async (): Promise<void> => {
  await keychain(SecureStore.setItemAsync(USED, '1', { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }));
};
