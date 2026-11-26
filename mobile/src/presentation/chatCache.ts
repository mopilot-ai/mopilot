// The last rows of each chat, kept sealed on the phone so a chat opened before paints from disk at once; bounded, and gone with the account or the computer.
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';
import type { CachedRow, SavedChanges } from './threadCache';
import { CACHE_CHATS, CACHE_ROWS } from './threadCache';

/** One sealed row per chat, oldest use first from `keys`; nothing but ciphertext reaches the store. */
export type ChatStore = {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key, least recently written first. */
  keys(): Promise<string[]>;
  clear(): Promise<void>;
};
export type ChatCrypto = {
  key(): Promise<Uint8Array>;
  /** Deletes the key, so that what was sealed under it cannot be read again (absent where the key is not the store's to delete). */
  forget?(): Promise<void>;
  randomBytes(n: number): Uint8Array;
  seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: string): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: string): Uint8Array | null;
};

/** A row's text is cut here and one chat's rows stay under CACHE_BYTES, so the cache is at most CACHE_CHATS x CACHE_BYTES on disk. */
export const CACHE_ROW_CHARS = 4000;
export const CACHE_BYTES = 120_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The newest rows that fit: at most CACHE_ROWS rows, each cut to CACHE_ROW_CHARS, and CACHE_BYTES of text in all. */
export function boundRows(rows: CachedRow[]): CachedRow[] {
  const kept: CachedRow[] = [];
  let bytes = 0;
  for (const r of rows.slice(-CACHE_ROWS).reverse()) {
    const row = {
      key: r.key,
      role: r.role,
      text: r.text.slice(0, CACHE_ROW_CHARS),
    };
    bytes += row.text.length + row.key.length + row.role.length;
    if (bytes > CACHE_BYTES) break;
    kept.push(row);
  }
  return kept.reverse();
}

/** Counts kept with the rows, when they are counts. */
function savedChanges(value: unknown): SavedChanges | null {
  const c = value as Partial<SavedChanges> | null | undefined;
  return c && [c.files, c.added, c.removed].every((n) => typeof n === 'number' && Number.isFinite(n))
    ? { files: c.files!, added: c.added!, removed: c.removed! }
    : null;
}

export function createChatCache({ store, crypto }: { store: ChatStore; crypto: ChatCrypto }) {
  // bound to the key it is stored under (the account, computer and chat), so a sealed row moved to another key does not open
  const aad = (key: string) => `chat-rows:${key}`;
  // bumped by every removal: a save that began before one (a chat left as its account signs out) must not write after it
  let epoch = 0;
  async function open(key: string): Promise<{ rows: CachedRow[]; changes: SavedChanges | null }> {
    const none = { rows: [], changes: null };
    const raw = await store.read(key);
    if (raw === null) return none;
    try {
      const saved = JSON.parse(raw) as { nonce: string; box: string };
      const plain = crypto.open(await crypto.key(), fromHex(saved.nonce), fromHex(saved.box), aad(key));
      if (!plain) return none;
      const value = JSON.parse(decoder.decode(plain)) as unknown;
      // a plain list (kept without a chip, or by a build before it) or the rows with their chip
      const chat = (Array.isArray(value) ? { rows: value } : value) as { rows?: unknown; changes?: unknown } | null;
      const rows = Array.isArray(chat?.rows) ? chat.rows : [];
      return {
        rows: boundRows(
          rows.filter((r): r is CachedRow => !!r && typeof r.key === 'string' && typeof r.text === 'string' && typeof r.role === 'string'),
        ),
        changes: savedChanges(chat?.changes),
      };
    } catch {
      return none;
    }
  }
  return {
    /** `changes`: the Changes chip the rows were shown with; without it the rows are kept as a plain list, as builds before it read them. */
    async save(key: string, rows: CachedRow[], changes: SavedChanges | null = null): Promise<void> {
      const began = epoch;
      const kept = boundRows(rows);
      // a chat with nothing to show keeps no old rows either
      if (!kept.length) return store.remove(key);
      const secret = await crypto.key();
      const nonce = crypto.randomBytes(24);
      const plain = JSON.stringify(changes ? { rows: kept, changes } : kept);
      const box = crypto.seal(secret, nonce, encoder.encode(plain), aad(key));
      if (began !== epoch) return;
      await store.write(key, JSON.stringify({ nonce: toHex(nonce), box: toHex(box) }));
      const keys = await store.keys();
      for (const old of keys.slice(0, Math.max(0, keys.length - CACHE_CHATS))) await store.remove(old);
    },
    /** The rows saved under `key`, or none when there are none, they are another key's, or they cannot be opened. */
    load: async (key: string): Promise<CachedRow[]> => (await open(key)).rows,
    /** The rows saved under `key` and the Changes chip they were shown with (null when none was kept). */
    loadChat: open,
    /** The chat is gone from the computer. */
    remove: (key: string) => (epoch++, store.remove(key)),
    /** Keeps only the chats `keep` says still exist (the computer's list is the truth). */
    async prune(keep: (key: string) => boolean): Promise<void> {
      epoch++;
      for (const key of await store.keys()) if (!keep(key)) await store.remove(key);
    },
    /** Signed out or unpaired: every saved chat goes. */
    clear: () => (epoch++, store.clear()),
  };
}
export type ChatCache = ReturnType<typeof createChatCache>;
