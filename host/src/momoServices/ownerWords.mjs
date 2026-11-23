// What the owner said to MoMo's main chat, kept on this Host for the notes (#5474): the message of a turn that is still running, as the Host received it from a paired owner device, so a note's source is the owner's own text and never something a model wrote. It is the owner's private words, so it lives only as long as the turn: it is dropped when the turn settles, one message per chat, a few chats, never past what the turn needed. Sealed under the home's storage (it moves with a move, Reset deletes it).
import { sealedStore } from '../momoCoreHost.mjs';
import { isOwner } from '../momoOwner.mjs';

/** How many chats keep a message at once, and how long a message is kept (in characters, cut on whole characters, never through a surrogate pair). */
export const KEEP_CHATS = 4;
export const MAX_TEXT = 4000;

/** @typedef {{ turnId: string, at: string, text: string, seen: number }} Words */

/** @param {any} v @returns {{ chats: Record<string, Words> }} */
const shape = (v) => {
  /** @type {Record<string, Words>} */
  const chats = {};
  for (const [id, m] of Object.entries(v?.chats ?? {})) {
    const w = /** @type {any} */ (m);
    if (typeof w?.turnId === 'string' && typeof w.at === 'string' && typeof w.text === 'string')
      chats[id] = { turnId: w.turnId, at: w.at, text: w.text, seen: Number.isFinite(w.seen) ? w.seen : 0 };
  }
  return { chats };
};

/** @param {{ home: any, report?: (m: string) => void, now?: () => number }} deps */
export default ({ home, now = Date.now }) => {
  /** @type {ReturnType<typeof sealedStore<ReturnType<typeof shape>>> | null} */
  let store = null;
  const open = () =>
    (store ??= sealedStore({ dir: home.storage.dir, name: 'owner-words.json', safeStorage: home.data.safeStorage, shape, now }));
  const api = {
    /**
     * A message the Host accepted for a chat. Kept only for the main chat and only from a paired owner device (not another Host, not a home client); false when it is not kept. It replaces the chat's earlier one, and when more chats than KEEP_CHATS hold a message the least recently heard goes, never the chat being written.
     * @param {{ turnId: string, chatId: string, text: unknown, principal?: { kind?: string } | null }} m
     */
    async heard({ turnId, chatId, text, principal }) {
      if (!home.stamp() || typeof text !== 'string' || !text.trim() || !home.chats?.isMain(chatId)) return false;
      if (!isOwner(principal)) return false;
      const at = new Date(now()).toISOString();
      await open().change((all) => {
        all.chats[chatId] = { turnId, at, text: Array.from(text).slice(0, MAX_TEXT).join(''), seen: now() };
        const others = Object.entries(all.chats)
          .filter(([id]) => id !== chatId)
          .sort((a, b) => a[1].seen - b[1].seen);
        for (const [id] of others.slice(0, Math.max(0, others.length - (KEEP_CHATS - 1)))) delete all.chats[id];
      });
      return true;
    },
    /** The words of the turn the chat is answering right now, or null: a background run, a told result or a turn that ended has none. @param {string} chatId */
    current(chatId) {
      if (!home.stamp()) return null;
      const m = open().read().chats[chatId];
      return m && home.stores().turns.status(m.turnId).state === 'accepted' ? m : null;
    },
    /** The chat's turn ended: its words are no longer kept. @param {string} chatId */
    async settled(chatId) {
      if (!home.stamp() || !(chatId in open().read().chats)) return;
      await open().change((all) => void delete all.chats[chatId]);
    },
  };
  /** One message of one chat, kept as a real one is. */
  const seed = async () => {
    await open().change((all) => {
      all.chats['momo-seed'] = { turnId: 'seed-0001', at: new Date(now()).toISOString(), text: 'I prefer email over calls', seen: now() };
    });
  };
  home.use('ownerWords', { seed, start: () => undefined, pause: () => undefined, wipe: () => void (store = null) });
  home.provide('ownerWords', api);
};
