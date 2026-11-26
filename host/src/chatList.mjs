// The chats a Host holds as `host.chats` answers them: the journal's summaries, each with the agent it runs on and the epoch the next request on it must carry. What the caller may not see is left out before the list is cut to its length, so a short list tells nothing about what was left out, and only chats it may see are looked at for a title.
import { before, createChatIndex, cursorOf } from './chatIndex.mjs';
import { chatScopeOf } from './chatScope.mjs';

/** The native sessions of a Host built without them: none (a call that asks for them was refused before it got here). */
const NO_NATIVE = { page: () => ({ chats: /** @type {object[]} */ ([]), next: /** @type {string | undefined} */ (undefined) }) };

/** How many chats one call finds a title for (the newest first); the answer says how many are left, and the phone asks again. */
export const FILL_PER_CALL = 10;
/** The most journal bytes one call reads for titles in all (a chat that does not fit what is left waits for a later call, which has a budget of its own). */
export const FILL_BYTES_PER_CALL = 16 * 1024 * 1024;

/**
 * @param {{ chats: () => Promise<any[]>, fillTitle: (chatId: string, budget: number) => { status: string, bytes?: number, title?: string, harness?: string, writeFailed?: true } }} log the chat log
 * @param {{ current: (chatId: string) => number }} epochs
 * @param {((who: unknown) => ((chatId: string) => boolean) | undefined) | undefined} [chatVisible] for a caller, which chats it may see (the protocol's chat veil gives it); everything is visible without one
 * @param {{ perCall?: number, bytes?: number }} [limits] how many titles and how many journal bytes one call may take on (the defaults above; a test makes them small)
 * @param {ReturnType<typeof createChatIndex>} [index] the Host's chat index, which the list is read from (one is made from the log when the Host has none: a list that reads the journals once)
 * @param {Pick<ReturnType<typeof import('./nativeIndex.mjs').createNativeIndex>, 'page'> | typeof NO_NATIVE} [native] the sessions started outside MoPilot (#5576), listed only when a call asks for them and its scope may see them
 */
export const chatListOf =
  (
    log,
    epochs,
    chatVisible,
    limits = {},
    index = createChatIndex({ load: () => log.chats(), epoch: (id) => epochs.current(id) }),
    native = NO_NATIVE,
  ) =>
  async (
    /** @type {{ limit: number, cursor?: string, origin?: 'native' | 'all' }} */ p,
    /** @type {unknown} */ who,
    /** @type {() => number} */ at = () => 0,
  ) => {
    const scope = chatScopeOf(chatVisible)(who);
    const asked = p.origin ?? 'host';
    if (asked === 'native') {
      // only sessions started outside MoPilot: nothing of the journals is read, and a caller that may not see them gets an empty list like any other
      await index.ready();
      const page = native.page(p, scope);
      return {
        chats: page.chats,
        titles: { pending: 0, deferred: 0 },
        ...(page.next ? { next: page.next } : {}),
        at: at(),
        generation: index.generation,
        ...(index.complete ? {} : { incomplete: /** @type {const} */ (true) }),
      };
    }
    const { chats: top, next: hostNext, generation, incomplete, at: seq } = await index.page(p, scope, at);
    const nativePage = asked === 'all' ? native.page(p, scope) : null;
    const next = hostNext;
    /** The chats of this answer that still have no title: found for the newest few now, `pending` for the rest, `deferred` for those that get theirs when opened. */
    const titles = { pending: 0, deferred: 0 };
    const chats = [];
    const perCall = limits.perCall ?? FILL_PER_CALL;
    let left = limits.bytes ?? FILL_BYTES_PER_CALL;
    let filled = 0;
    /** A write that failed ends the filling for this call (the rest wait for a later one), so a full disk is tried and reported once. */
    let stopped = false;
    /** Whether this row's title was just found, which lets the event loop go before the next. */
    let justFilled = false;
    for (const { standIn, ...c } of top) {
      if (standIn) {
        if (stopped || filled >= perCall) titles.pending++;
        else {
          const found = log.fillTitle(c.chatId, left);
          if (found.status === 'gone') continue;
          if (found.status === 'later') {
            // too big for what is left of this call's budget: it and the rest (older) wait for a later call, so the order stays newest first
            stopped = true;
            titles.pending++;
          } else if (found.status === 'deferred') {
            if (found.writeFailed) {
              stopped = true;
              titles.pending++;
            } else titles.deferred++;
          } else {
            c.title = /** @type {string} */ (found.title);
            c.harness = found.harness ?? c.harness;
            index.filled(c.chatId, { title: c.title, harness: found.harness });
            if (found.status === 'filled') {
              filled++;
              left -= /** @type {number} */ (found.bytes);
              justFilled = true;
            }
          }
        }
      }
      chats.push(c);
      // one chat's journal at a time, with the event loop let go after each filled one
      if (justFilled) {
        justFilled = false;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (nativePage) {
      // both sources are in the same order (newest activity first, then id) from the same place, so the first `limit` of their merge are the first of the whole
      const merged = [...chats, ...nativePage.chats].sort((a, b) => (before(a, b) ? -1 : 1));
      const cut = merged.slice(0, p.limit);
      const last = cut[cut.length - 1];
      const more = merged.length > p.limit || !!hostNext || !!nativePage.next;
      return {
        chats: cut,
        titles,
        ...(more && last ? { next: cursorOf(last) } : {}),
        at: seq,
        generation,
        ...(incomplete ? { incomplete } : {}),
      };
    }
    return { chats, titles, ...(next ? { next } : {}), at: seq, generation, ...(incomplete ? { incomplete } : {}) };
  };
