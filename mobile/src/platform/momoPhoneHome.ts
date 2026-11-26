// Device-only storage for the home the phone composes itself: one sealed SQLite row for each account (so another account never writes over it) and a Keychain/Keystore key that never leaves the phone (its own key, apart from the home copy's and MoMo's memory copy). Nothing is opened until MoMo's home needs it.
import { openDatabase } from './sqliteOpen';
import { sealedCrypto } from './sealedCrypto';
import { randomId } from './randomId';

const KEY = 'mobile-remote-momo-phone-home-key';
const TABLE = 'momo_phone_home_rows';

/** Counted up whenever the rows are all forgotten: a container opened before can no longer write, so a write still in flight at sign-out cannot bring a row back. */
let epoch = 0;

const open = async () => {
  const db = await openDatabase('mobile-remote-momo-phone-home.db');
  await db.execAsync(`CREATE TABLE IF NOT EXISTS ${TABLE} (user TEXT PRIMARY KEY, value TEXT)`);
  return db;
};

/** The container of one account's row, with the sealing and the ids the home needs. */
export async function openPhoneHomeSealed(user: string) {
  const db = await open();
  const mine = epoch;
  return {
    store: {
      read: async () =>
        (await db.getFirstAsync<{ value: string | null }>(`SELECT value FROM ${TABLE} WHERE user = ?`, user))?.value ?? null,
      write: async (value: string) => {
        if (mine !== epoch) return;
        await db.runAsync(`INSERT OR REPLACE INTO ${TABLE} (user, value) VALUES (?, ?)`, user, value);
      },
      clear: async () => {
        await db.runAsync(`DELETE FROM ${TABLE} WHERE user = ?`, user);
      },
    },
    crypto: sealedCrypto(KEY),
    /** Unguessable ids: they are also the tokens of the choices the owner confirms (use or delete the older MoMo). */
    newId: randomId,
  };
}

/** Leaving the account on this phone: every row goes, whoever it was kept for. */
export async function forgetPhoneHome() {
  epoch++;
  const db = await open();
  await db.runAsync(`DELETE FROM ${TABLE}`);
}
