// The thumbnails of the pictures attached to messages, kept sealed on the phone so a chat reopened (or the app relaunched) draws them at once instead of asking the computer again; bounded, and gone with the account or the computer.
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';
import type { ChatCrypto, ChatStore } from './chatCache';

/** How many thumbnails are kept (each at most ~180 KB as the computer sends them): the newest written stay. */
export const PICTURES_KEPT = 120;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A picture the phone draws: a JPEG as a data URI, nothing else. */
const DRAWABLE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** The key a picture is kept under: the account, the computer, the chat, the message, the picture's place and the side asked. */
export const pictureKey = (account: string, pair: string, chatId: string, itemId: string, index: number, side: number) =>
  JSON.stringify([account, pair, chatId, itemId, index, side]);

export function createPictureCache({ store, crypto }: { store: ChatStore; crypto: ChatCrypto }) {
  // bound to the key it is stored under, so a sealed picture moved to another key (another account's) does not open
  const aad = (key: string) => `chat-picture:${key}`;
  // bumped by every removal: a save that began before one (an account signing out) must not write after it
  let epoch = 0;
  return {
    async save(key: string, uri: string): Promise<void> {
      if (!DRAWABLE.test(uri)) return;
      const began = epoch;
      const secret = await crypto.key();
      const nonce = crypto.randomBytes(24);
      const box = crypto.seal(secret, nonce, encoder.encode(uri), aad(key));
      if (began !== epoch) return;
      await store.write(key, JSON.stringify({ nonce: toHex(nonce), box: toHex(box) }));
      const keys = await store.keys();
      for (const old of keys.slice(0, Math.max(0, keys.length - PICTURES_KEPT))) await store.remove(old);
    },
    /** The picture saved under `key`, or null when there is none, it is another key's, or it cannot be opened. */
    async load(key: string): Promise<string | null> {
      const raw = await store.read(key);
      if (raw === null) return null;
      try {
        const saved = JSON.parse(raw) as { nonce: string; box: string };
        const plain = crypto.open(await crypto.key(), fromHex(saved.nonce), fromHex(saved.box), aad(key));
        const uri = plain ? decoder.decode(plain) : '';
        return DRAWABLE.test(uri) ? uri : null;
      } catch {
        return null;
      }
    },
    /** Keeps only the pictures `keep` says still belong (a deleted chat's, a removed computer's). */
    async prune(keep: (key: string) => boolean): Promise<void> {
      epoch++;
      for (const key of await store.keys()) if (!keep(key)) await store.remove(key);
    },
    /** Signed out: every saved picture goes. */
    clear: () => (epoch++, store.clear()),
  };
}
export type PictureCache = ReturnType<typeof createPictureCache>;
