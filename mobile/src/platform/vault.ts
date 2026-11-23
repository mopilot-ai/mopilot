// SQLite transaction and device-only key adapters for the encrypted phone vault.
import * as SecureStore from 'expo-secure-store';
import { openDatabase } from './sqliteOpen';
import { keychain } from '../bounded';

let vaultQueue: Promise<void> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = vaultQueue.then(work);
  vaultQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function openVaultStorage() {
  const db = await serialize(async () => {
    const opened = await openDatabase('mobile-remote.db');
    await opened.execAsync('CREATE TABLE IF NOT EXISTS phone_vault (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT)');
    return opened;
  });
  // The key never changes once it exists, so it is read from the keychain once and kept. On a device, a keychain read inside an open exclusive
  // transaction made every later keychain read about twice as slow as the one before (a pairing spent 17 s on them and the phone gave up
  // before it reached the relay; a simulator is unaffected). A missing key is not kept: it is asked for again inside the lock, where the
  // vault decides whether to make one.
  let key: string | null = null;
  // every keychain call is bounded: one that never answers fails the start with a reason, which Retry clears (#3644)
  const readKey = async () => (key ??= await keychain(SecureStore.getItemAsync('mobile-remote-vault-key')));
  return {
    key: {
      get: readKey,
      set: async (value: string) => {
        await keychain(
          SecureStore.setItemAsync('mobile-remote-vault-key', value, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }),
        );
        key = value;
      },
    },
    async transaction<T>(
      fn: (row: { read: () => Promise<string | null>; write: (value: string) => Promise<void> }) => Promise<T>,
    ): Promise<T> {
      return serialize(async () => {
        let result!: T;
        // before the transaction opens, not inside it (see above)
        await readKey();
        await db.withExclusiveTransactionAsync(async (tx) => {
          // Force a write transaction before reading either the row or its SecureStore key.
          await tx.runAsync('INSERT OR IGNORE INTO phone_vault (id, value) VALUES (1, NULL)');
          result = await fn({
            read: async () =>
              (await tx.getFirstAsync<{ value: string | null }>('SELECT value FROM phone_vault WHERE id = 1'))?.value ?? null,
            write: async (value) => {
              await tx.runAsync('UPDATE phone_vault SET value = ? WHERE id = 1', value);
            },
          });
        });
        return result;
      });
    },
  };
}
