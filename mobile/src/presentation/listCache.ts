// The last chat list read from each computer, kept sealed on the phone so the list paints from disk at launch and the live one replaces it in place; bounded, and gone with the account or the computer.
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';
import type { ChatListItem } from '../components/ChatRow';
import type { ChatCrypto, ChatStore } from './chatCache';

/** The newest chats kept: one page of the list, which is all that is shown before the computer answers. */
export const LIST_KEPT = 50;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const usable = (c: unknown): c is ChatListItem => !!c && typeof (c as ChatListItem).id === 'string';

export function createListCache({ store, crypto }: { store: ChatStore; crypto: ChatCrypto }) {
  // bound to the key it is stored under (the account and computer), so a sealed list moved to another key does not open
  const aad = (key: string) => `chat-list:${key}`;
  // bumped by every removal: a save that began before one (an account signing out) must not write after it
  let epoch = 0;
  return {
    async save(key: string, chats: ChatListItem[]): Promise<void> {
      const began = epoch;
      const kept = chats.slice(0, LIST_KEPT);
      if (!kept.length) return store.remove(key);
      const secret = await crypto.key();
      const nonce = crypto.randomBytes(24);
      const box = crypto.seal(secret, nonce, encoder.encode(JSON.stringify(kept)), aad(key));
      if (began !== epoch) return;
      await store.write(key, JSON.stringify({ nonce: toHex(nonce), box: toHex(box) }));
    },
    /** The list saved under `key`, or none when there is none, it is another key's, or it cannot be opened. */
    async load(key: string): Promise<ChatListItem[]> {
      const raw = await store.read(key);
      if (raw === null) return [];
      try {
        const saved = JSON.parse(raw) as { nonce: string; box: string };
        const plain = crypto.open(await crypto.key(), fromHex(saved.nonce), fromHex(saved.box), aad(key));
        if (!plain) return [];
        const chats = JSON.parse(decoder.decode(plain)) as unknown;
        return Array.isArray(chats) ? chats.filter(usable).slice(0, LIST_KEPT) : [];
      } catch {
        return [];
      }
    },
    /** Keeps only the lists `keep` says still belong (a computer removed from this phone takes its list). */
    async prune(keep: (key: string) => boolean): Promise<void> {
      epoch++;
      for (const key of await store.keys()) if (!keep(key)) await store.remove(key);
    },
    /** Signed out: every saved list goes. */
    clear: () => (epoch++, store.clear()),
  };
}
export type ListCache = ReturnType<typeof createListCache>;
