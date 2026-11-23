// The last rows each chat showed, kept in memory so a chat whose computer goes away still shows what was there (cache-first, as in Cursor).

export type CachedRow = { key: string; role: string; text: string };

/** How many chats and rows are kept: enough to reopen the recent ones, little enough to stay small. */
export const CACHE_CHATS = 20;
export const CACHE_ROWS = 60;

const cache = new Map<string, CachedRow[]>();

/**
 * Keeps a chat's rows under `key` (the account, computer and chat, as drafts are keyed), the newest chats last and
 * only the last CACHE_ROWS rows; an empty list keeps what was there, so a chat reloading does not wipe it.
 */
export function rememberRows(key: string, rows: CachedRow[]) {
  if (!rows.length) return;
  cache.delete(key);
  cache.set(key, rows.slice(-CACHE_ROWS));
  if (cache.size > CACHE_CHATS) cache.delete(cache.keys().next().value!);
}

/** The rows last shown for `key`, or none. */
export const recentRows = (key: string): CachedRow[] => cache.get(key) ?? [];

/** Forgets every chat: an account leaving the phone takes its history with it. */
export const forgetRows = () => cache.clear();

/** Forgets one chat: it is gone from the computer. */
export const forgetRow = (key: string) => void cache.delete(key);

/** The chat ids kept in memory under keys that start with `prefix` (an account and computer: `["u","p",`). */
export const recentChatIds = (prefix: string): string[] =>
  [...cache.keys()].filter((key) => key.startsWith(prefix)).map((key) => (JSON.parse(key) as string[])[2]);

/** Forgets every chat kept for one computer: it was removed from this phone. */
export function forgetPairRows(pairId: string) {
  for (const key of [...cache.keys()]) if ((JSON.parse(key) as string[])[1] === pairId) cache.delete(key);
}
