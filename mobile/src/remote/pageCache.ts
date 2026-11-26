// The older rows of each chat as the Mac sent them, kept sealed on the phone so reopening a long chat finds its history above the first snapshot at once (#5379): a first paint, never the truth; bounded, and gone with the account, the computer or the chat.
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';
import type { ChatCache, ChatCrypto, ChatStore } from '../presentation/chatCache';
import type { Data } from '../presentation/thread';

/**
 * What one chat keeps: the rows, whether the chat goes back further than the oldest, the Mac's name for what the history started as when it sent one,
 * and when the rows were last known to be the Mac's (`at`: the last time they were read from it or set against what it has; a save without it is now).
 */
export type PageSnapshot = { rows: Data[]; more: boolean; epoch?: string; at?: number };

/** One chat's JSON stays under PAGE_BYTES (the newest rows kept), no saved row is over PAGE_ROW_BYTES, PAGE_CHATS chats are kept, and an entry older than PAGE_MAX_AGE_MS is not used. */
export const PAGE_BYTES = 300_000;
export const PAGE_ROW_BYTES = 16_000;
export const PAGE_CHATS = 40;
export const PAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A copy the Mac named no epoch for has only the first-row match and one page set against the Mac to vouch for it: it is used for less time since it was last known to be right. */
export const PAGE_MAX_AGE_NO_EPOCH_MS = 2 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const idOf = (r: Data) => (typeof r.id === 'string' && r.id ? r.id : null);

/**
 * The newest run of rows that is kept: contiguous from the newest back, stopping at the first row over PAGE_ROW_BYTES (a row is never cut:
 * what is shown from the cache is what the Mac sent) or when PAGE_BYTES is reached, and starting at a row that has an id, which is where the
 * page before it is asked from.
 */
export function boundPages(rows: readonly Data[]): Data[] {
  const kept: Data[] = [];
  let bytes = 0;
  for (const r of [...rows].reverse()) {
    const size = JSON.stringify(r).length;
    if (size > PAGE_ROW_BYTES || bytes + size > PAGE_BYTES) break;
    bytes += size;
    kept.push(r);
  }
  kept.reverse();
  const first = kept.findIndex((r) => idOf(r));
  return first < 0 ? [] : kept.slice(first);
}

export function createPageCache({ store, crypto, now = Date.now }: { store: ChatStore; crypto: ChatCrypto; now?: () => number }) {
  // bound to the key it is stored under (the account, computer and chat), so a sealed copy moved to another one does not open
  const aad = (key: string) => `chat-pages:${key}`;
  // bumped by a clear (every chat) and, per chat, by a removal of that chat: a save that began before one (a chat left as its account signs out) must not write after it.
  // A prune that removes nothing for a chat changes nothing for it, so a chat list that is read again does not stop the open chat from saving.
  let epoch = 0;
  const removals = new Map<string, number>();
  const generationOf = (key: string) => `${epoch}:${removals.get(key) ?? 0}`;
  const removed = (key: string) => removals.set(key, (removals.get(key) ?? 0) + 1);
  // writes to one key go one after another
  const writes = new Map<string, Promise<unknown>>();
  return {
    /** What has been removed of this chat so far: a screen takes it as it opens a chat and passes it back with its save, so a save after a sign-out, a clear or the chat's removal is refused. */
    generation: generationOf,
    /**
     * Keeps `snap` under `key` (its newest bounded run); a chat with nothing to keep keeps nothing. False when nothing was written, or when a removal came
     * after `since` (the generation the caller saw; the generation now when it is not given). Rows left out for the bounds say the chat goes back further.
     */
    async save(key: string, snap: PageSnapshot, since?: string): Promise<boolean> {
      const began = since ?? generationOf(key);
      if (began !== generationOf(key)) return false;
      const rows = boundPages(snap.rows);
      if (!rows.length) {
        await store.remove(key);
        return false;
      }
      const body = {
        v: 1,
        rows,
        more: snap.more || rows.length < snap.rows.length,
        at: snap.at ?? now(),
        ...(snap.epoch ? { epoch: snap.epoch } : {}),
      };
      const secret = await crypto.key();
      const nonce = crypto.randomBytes(24);
      const box = crypto.seal(secret, nonce, encoder.encode(JSON.stringify(body)), aad(key));
      const turn = (writes.get(key) ?? Promise.resolve()).then(async () => {
        if (began !== generationOf(key)) return false;
        await store.write(key, JSON.stringify({ nonce: toHex(nonce), box: toHex(box) }));
        const keys = await store.keys();
        for (const old of keys.slice(0, Math.max(0, keys.length - PAGE_CHATS))) await store.remove(old);
        return true;
      });
      writes.set(
        key,
        turn.catch(() => undefined),
      );
      return turn;
    },
    /** The rows saved under `key`, or null when there are none, they are another key's, they cannot be opened or they are too old: it is a first paint, so anything doubtful is no cache. */
    async load(key: string): Promise<PageSnapshot | null> {
      const raw = await store.read(key);
      if (raw === null) return null;
      try {
        const saved = JSON.parse(raw) as { nonce: string; box: string };
        const plain = crypto.open(await crypto.key(), fromHex(saved.nonce), fromHex(saved.box), aad(key));
        if (!plain) return null;
        const body = JSON.parse(decoder.decode(plain)) as {
          v?: number;
          rows?: unknown;
          more?: unknown;
          at?: unknown;
          epoch?: unknown;
        } | null;
        if (!body || body.v !== 1 || !Array.isArray(body.rows) || typeof body.more !== 'boolean' || typeof body.at !== 'number')
          return null;
        if (now() - body.at > (typeof body.epoch === 'string' ? PAGE_MAX_AGE_MS : PAGE_MAX_AGE_NO_EPOCH_MS)) {
          // out of date: the rows go from the disk too, not only from sight
          await store.remove(key);
          return null;
        }
        const rows = body.rows.filter((r): r is Data => !!r && typeof r === 'object' && !Array.isArray(r));
        if (rows.length !== body.rows.length || !rows.length || !idOf(rows[0])) return null;
        return { rows, more: body.more, at: body.at, ...(typeof body.epoch === 'string' ? { epoch: body.epoch } : {}) };
      } catch {
        return null;
      }
    },
    /** A copy that does not belong above what the Mac shows is dropped. Unlike `remove`, it does not stop this screen's own later save of what the Mac showed. */
    discard: (key: string) => store.remove(key),
    /** The chat is gone from the computer: its saved rows go, and a save that began before this is refused. */
    remove(key: string) {
      removed(key);
      return store.remove(key);
    },
    /** Keeps only the chats `keep` says still belong (the account, the computer and the computer's own list are the truth). */
    async prune(keep: (key: string) => boolean): Promise<void> {
      const gone = (await store.keys()).filter((key) => !keep(key));
      for (const key of gone) removed(key);
      for (const key of gone) await store.remove(key);
    },
    /** Signed out, unpaired or cleared from Settings: every saved chat goes, and so does the key they were sealed under. */
    async clear() {
      epoch++;
      await store.clear();
      await crypto.forget?.();
    },
  };
}
export type PageCache = ReturnType<typeof createPageCache>;

/**
 * A page cache that is there before it is open: calls wait for `ready` and go through it in order, so the rows cache is never held up by the page
 * cache's own checks (the Keychain, the install marker). When it cannot be opened (a locked device: the Keychain does not answer) it is not there for
 * the session: nothing is read, written or deleted, and a later launch tries again.
 */
export function lazyPageCache(ready: Promise<PageCache>): PageCache {
  let open: PageCache | null = null;
  const settled = ready.then(
    (cache) => (open = cache),
    () => null,
  );
  const through = <T>(use: (cache: PageCache) => Promise<T>, none: T) => settled.then((cache) => (cache ? use(cache) : none));
  return {
    // before it is open nothing has been removed: the generation every cache starts at
    generation: (key) => open?.generation(key) ?? '0:0',
    save: (key, snap, since) => through((c) => c.save(key, snap, since), false),
    load: (key) => through((c) => c.load(key), null),
    discard: (key) => through((c) => c.discard(key), undefined),
    remove: (key) => through((c) => c.remove(key), undefined),
    prune: (keep) => through((c) => c.prune(keep), undefined),
    clear: () => through((c) => c.clear(), undefined),
  };
}

/** The phone's saved rows with the saved older pages beside them: one cache to the rest of the app, so signing out, unpairing, a deleted chat and Settings clear both. */
export type PagedChatCache = ChatCache & { pages?: PageCache };
export function withPages(rows: ChatCache, pages: PageCache): PagedChatCache {
  const both = (one: (c: ChatCache | PageCache) => Promise<unknown> | unknown) =>
    Promise.all([one(rows), one(pages)]).then(() => undefined);
  return {
    ...rows,
    pages,
    remove: (key) => both((c) => c.remove(key)),
    prune: (keep) => both((c) => c.prune(keep)),
    clear: () => both((c) => c.clear()),
  };
}
