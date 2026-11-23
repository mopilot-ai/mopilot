// The last items of each chat as the Mac sent them, kept sealed on the phone with the revision they were read at, so a chat opens from disk and asks the Mac only for what differs; scoped by account and machine, bounded, and gone with either.
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';
import type { ChatCrypto, ChatStore } from '../presentation/chatCache';

/** One chat's items and where they were read: the Mac's revision and feed sequence, and the generation of its log when it has one. */
export type ItemSnapshot = { rev: number; feedSeq: number; generation?: string; items: { id?: string }[] };

/** How many chats are kept, and the most JSON one chat may take (the oldest items go first). */
export const ITEM_CHATS = 40;
export const ITEM_BYTES = 200_000;

/** The key of a chat's items. */
export const itemKey = (account: string, machineId: string, chatId: string) => `${account}\n${machineId}\n${chatId}`;
/** The prefix that every chat of an account (no machine) or of one machine of an account has: it ends in the separator, so one id is never the start of another. */
export const scopePrefix = (account: string, machineId?: string) =>
  machineId === undefined ? `${account}\n` : `${account}\n${machineId}\n`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The newest items that fit ITEM_BYTES. */
export function boundItems(items: ItemSnapshot['items']): ItemSnapshot['items'] {
  const kept: ItemSnapshot['items'] = [];
  let bytes = 0;
  for (const item of [...items].reverse()) {
    bytes += JSON.stringify(item).length;
    if (bytes > ITEM_BYTES) break;
    kept.push(item);
  }
  return kept.reverse();
}

export function createItemCache({ store, crypto }: { store: ChatStore; crypto: ChatCrypto }) {
  // bound to the key it is stored under, so a sealed copy moved to another account, machine or chat does not open
  const aad = (key: string) => `chat-items:${key}`;
  // bumped by every removal: a save that began before one (a machine revoked as its chat was read) must not write after it
  let epoch = 0;
  // the last ticket that saved under each key: a read that began earlier and finishes later is the older picture and is not kept
  const tickets = new Map<string, { issued: number; saved: number }>();
  const writes = new Map<string, Promise<unknown>>();
  const ticketOf = (key: string) => {
    let t = tickets.get(key);
    if (!t) tickets.set(key, (t = { issued: 0, saved: 0 }));
    return t;
  };
  return {
    /** Numbers a read of `key` as it begins; its answer is kept only if no read that began later was kept first. */
    begin(key: string): number {
      return ++ticketOf(key).issued;
    },
    /** Keeps `snap` under `key`; false when a later read was kept already, or a removal came after this one began. */
    async save(key: string, ticket: number, snap: ItemSnapshot): Promise<boolean> {
      const began = epoch;
      const t = ticketOf(key);
      if (ticket < t.saved) return false;
      t.saved = ticket;
      const items = boundItems(snap.items);
      if (!items.length) {
        await store.remove(key);
        return true;
      }
      const body = { rev: snap.rev, feedSeq: snap.feedSeq, ...(snap.generation ? { generation: snap.generation } : {}), items };
      const secret = await crypto.key();
      const nonce = crypto.randomBytes(24);
      const box = crypto.seal(secret, nonce, encoder.encode(JSON.stringify(body)), aad(key));
      // writes to one key go one after another, each looking again as its turn comes: a later read kept in the meantime, or a removal, makes this the older picture
      const turn = (writes.get(key) ?? Promise.resolve()).then(async () => {
        if (began !== epoch || ticket < ticketOf(key).saved) return false;
        await store.write(key, JSON.stringify({ nonce: toHex(nonce), box: toHex(box) }));
        const keys = await store.keys();
        for (const old of keys.slice(0, Math.max(0, keys.length - ITEM_CHATS))) await store.remove(old);
        return true;
      });
      writes.set(
        key,
        turn.catch(() => undefined),
      );
      return turn;
    },
    /** The items saved under `key`, or null when there are none, they are another key's, or they cannot be opened. */
    async load(key: string): Promise<ItemSnapshot | null> {
      const raw = await store.read(key);
      if (raw === null) return null;
      try {
        const saved = JSON.parse(raw) as { nonce: string; box: string };
        const plain = crypto.open(await crypto.key(), fromHex(saved.nonce), fromHex(saved.box), aad(key));
        if (!plain) return null;
        const body = JSON.parse(decoder.decode(plain)) as Partial<ItemSnapshot> | null;
        if (!body || typeof body.rev !== 'number' || typeof body.feedSeq !== 'number' || !Array.isArray(body.items)) return null;
        return {
          rev: body.rev,
          feedSeq: body.feedSeq,
          ...(typeof body.generation === 'string' ? { generation: body.generation } : {}),
          items: body.items.filter((i): i is { id?: string } => !!i && typeof i === 'object'),
        };
      } catch {
        return null;
      }
    },
    /** The chat is gone from the machine. */
    remove(key: string) {
      epoch++;
      tickets.delete(key);
      return store.remove(key);
    },
    /** A machine was revoked or an account left: every chat saved under `prefix` (see scopePrefix) goes. */
    async dropScope(prefix: string): Promise<void> {
      epoch++;
      for (const key of await store.keys())
        if (key.startsWith(prefix)) {
          tickets.delete(key);
          await store.remove(key);
        }
    },
    /** Signed out or unpaired: every saved chat goes. */
    clear() {
      epoch++;
      tickets.clear();
      return store.clear();
    },
  };
}
export type ItemCache = ReturnType<typeof createItemCache>;
