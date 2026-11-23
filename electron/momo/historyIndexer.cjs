// Keeps MoMo's index of its past chats (historyIndex.cjs) up to date (#2999 P1): a MoMo chat's finished turn is read from the shared peer transcript (the same for every harness) and its new turns are added, one chunk per question and answer; every MoMo chat is read once in the background at start, so chats from before the index are found too. Coding chats are never read. The <momo-context> block a turn carried is left out, so the index holds what was said, not MoMo's memory.

const { noteIgnored } = require('../ignored.cjs');
const { withoutMomoBlock } = require('../../shared/momoContext.mjs');
const { userMessageText } = require('./turnItems.cjs');

/** A user message as the user typed it: the memory block a turn starts with taken off. */
const typed = withoutMomoBlock;

/** When a turn happened: the earliest time any of its items started, else `fallback`. */
function timeOf(/** @type {any} */ turn, /** @type {number} */ fallback) {
  const times = Object.values(turn?.itemTimes ?? {})
    .map((t) => (typeof t === 'number' ? t : /** @type {any} */ (t)?.start))
    .filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? Math.min(...times) : fallback;
}

/**
 * The chunks of a chat's turns: one per turn with what the user wrote and what MoMo answered (its messages, tool calls
 * left out); a turn with neither is skipped.
 * @param {any[]} turns
 * @param {{ chatId: string, harness: string, kind: import('./historyIndex.cjs').ChatKind, now: number }} o
 * @returns {import('./historyIndex.cjs').Chunk[]}
 */
function chunksOf(turns, { chatId, harness, kind, now }) {
  const out = [];
  for (const [i, turn] of (Array.isArray(turns) ? turns : []).entries()) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    const user = items
      .filter((/** @type {any} */ it) => it?.type === 'userMessage')
      .map((/** @type {any} */ it) => typed(userMessageText(it)))
      .filter(Boolean)
      .join('\n');
    const assistant = items
      .filter((/** @type {any} */ it) => it?.type === 'agentMessage' && typeof it.text === 'string')
      .map((/** @type {any} */ it) => it.text.trim())
      .filter(Boolean)
      .join('\n');
    if (!user && !assistant) continue;
    out.push({ chatId, turnId: String(turn?.id ?? `t${i}`), at: timeOf(turn, now), harness, kind, user, assistant });
  }
  return out;
}

/**
 * @param {object} o
 * @param {InstanceType<typeof import('./historyIndex.cjs').HistoryIndex>} o.index
 * @param {(chatId: string) => Promise<{ turns: any[] } | null | undefined>} o.readHistory the shared peer transcript of a chat
 * @param {(chatId: string) => import('./historyIndex.cjs').ChatKind | null} o.kindOf which MoMo chat it is; null for any other chat
 * @param {(chatId: string) => string | undefined} o.harnessOf the chat's harness now
 * @param {() => string[]} o.chatIds every MoMo chat, for the backfill
 * @param {() => boolean} o.allowed MoMo is on for the account
 * @param {() => number} [o.now]
 */
function createHistoryIndexer({ index, readHistory, kindOf, harnessOf, chatIds, allowed, now = Date.now }) {
  /** chats whose index is being brought up to date, and those asked for again meanwhile */
  const running = new Set();
  const again = new Set();

  async function update(/** @type {string} */ chatId) {
    const kind = kindOf(chatId);
    if (!kind || allowed() !== true || !index.available()) return 0;
    const history = await readHistory(chatId);
    // MoMo may have gone off, or the chat may have stopped being MoMo's, while the transcript was read
    if (!history || allowed() !== true || kindOf(chatId) == null) return 0;
    const known = index.indexedTurns(chatId);
    const fresh = chunksOf(history.turns, { chatId, harness: harnessOf(chatId) ?? '', kind, now: now() }).filter(
      (c) => !known.has(c.turnId),
    );
    return index.add(fresh);
  }

  /**
   * Brings one chat's index up to date; a second ask while one runs waits for it and runs once more, so a turn that
   * ended meanwhile is not missed. Resolves how many chunks were added; a failure is noted, never thrown.
   * @param {string} chatId
   * @returns {Promise<number>}
   */
  async function queue(chatId) {
    if (running.has(chatId)) {
      again.add(chatId);
      return 0;
    }
    running.add(chatId);
    let added = 0;
    try {
      do {
        again.delete(chatId);
        added += await update(chatId);
      } while (again.has(chatId));
    } catch (error) {
      noteIgnored("index a MoMo chat's turns", error);
    } finally {
      running.delete(chatId);
    }
    return added;
  }

  return {
    queue,
    /** Every MoMo chat, one at a time, in the background; resolves how many chunks were added. */
    async backfill() {
      let added = 0;
      for (const id of chatIds()) added += await queue(id);
      return added;
    },
  };
}

module.exports = { createHistoryIndexer, chunksOf, typed };
