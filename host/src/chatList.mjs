// The chats a Host holds as `host.chats` answers them: the journal's summaries, each with the agent it runs on and the epoch the next request on it must carry. What the caller may not see is left out before the list is cut to its length, so a short list tells nothing about what was left out, and only chats it may see are looked at for a title.
import { harnessOfHostChat } from '../../shared/host/chatIds.mjs';
import { sideChatUuid } from '../../shared/host/sideChats.mjs';

/** How many chats one call finds a title for (the newest first); the answer says how many are left, and the phone asks again. */
export const FILL_PER_CALL = 10;
/** The most journal bytes one call reads for titles in all (a chat that does not fit what is left waits for a later call, which has a budget of its own). */
export const FILL_BYTES_PER_CALL = 16 * 1024 * 1024;

/**
 * @param {{ chats: () => Promise<any[]>, fillTitle: (chatId: string, budget: number) => { status: string, bytes?: number, title?: string, harness?: string, writeFailed?: true } }} log the chat log
 * @param {{ current: (chatId: string) => number }} epochs
 * @param {((who: unknown) => ((chatId: string) => boolean) | undefined) | undefined} [chatVisible] for a caller, which chats it may see (the protocol's chat veil gives it); everything is visible without one
 * @param {{ perCall?: number, bytes?: number }} [limits] how many titles and how many journal bytes one call may take on (the defaults above; a test makes them small)
 */
export const chatListOf =
  (log, epochs, chatVisible, limits = {}) =>
  async (/** @type {{ limit: number }} */ p, /** @type {unknown} */ who) => {
    const visible = chatVisible?.(who);
    const top = (await log.chats()).filter((c) => !sideChatUuid(c.chatId) && (!visible || visible(c.chatId))).slice(0, p.limit);
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
            c.title = found.title;
            c.harness = found.harness ?? c.harness;
            if (found.status === 'filled') {
              filled++;
              left -= /** @type {number} */ (found.bytes);
              justFilled = true;
            }
          }
        }
      }
      chats.push({ ...c, harness: c.harness ?? harnessOfHostChat(c.chatId), epoch: epochs.current(c.chatId) });
      // one chat's journal at a time, with the event loop let go after each filled one
      if (justFilled) {
        justFilled = false;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return { chats, titles };
  };
