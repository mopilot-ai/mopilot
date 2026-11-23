// The data budget of a followed turn (design: a followed turn costs the phone under 2 MB): the live item events a phone gets for one turn pass freely until their size reaches a share of that budget, then a tool's output, diff or other long text in the items that follow is cut short (with a note), so a turn with huge tool outputs still costs the phone a bounded amount. What the person reads, the assistant's messages, the reasoning and the user's own, is never cut here.
'use strict';
const { shorten } = require('./fitFrame.cjs');

/** Bytes of events (as JSON) a phone gets for one turn before tool output is cut. About 1.45 times that crosses the wire sealed, framed and acknowledged (tests/mobileStackBudget.test.ts). */
const SOFT_BYTES = 900_000;
/** The longest a string of a tool item may be once the budget is spent. */
const TAIL_CHARS = 1_500;
/** Items that are what the person reads: never cut. */
const PROSE = new Set(['agentMessage', 'userMessage', 'reasoning', 'plan', 'statusNote', 'contextCompaction', 'exitedReviewMode']);
/** Phones and chats remembered at once: the oldest goes past this many. */
const KEEP = 500;

const sizeOf = (/** @type {unknown} */ value) => Buffer.byteLength(JSON.stringify(value));

/**
 * @param {{ soft?: number, cap?: number }} [o]
 */
function createEventBudget({ soft = SOFT_BYTES, cap = TAIL_CHARS } = {}) {
  /** @type {Map<string, number>} per phone and chat: the bytes of this turn's events sent so far */
  const spent = new Map();
  return {
    /** A phone started or stopped following the chat: whatever it spent on an earlier turn does not count against the next one. */
    forget(/** @type {string} */ pairId, /** @type {string} */ chatId) {
      spent.delete(`${pairId}\n${chatId}`);
    },
    /**
     * The event as this phone should get it: unchanged while the turn is within budget, else with its tool items' long strings cut.
     * @template {{ ev?: string, items?: any[], started?: boolean }} T
     * @param {string} pairId
     * @param {string} chatId
     * @param {T} event
     * @returns {T}
     */
    fit(pairId, chatId, event) {
      const key = `${pairId}\n${chatId}`;
      // a turn starting or ending starts the count again
      if (event.ev === 'turn.state') spent.delete(key);
      const used = spent.get(key) ?? 0;
      const out =
        used >= soft && Array.isArray(event.items)
          ? { ...event, items: event.items.map((/** @type {any} */ item) => (PROSE.has(item?.type) ? item : shorten(item, cap))) }
          : event;
      spent.delete(key);
      spent.set(key, used + sizeOf(out));
      if (spent.size > KEEP) spent.delete(/** @type {string} */ (spent.keys().next().value));
      return out;
    },
  };
}

module.exports = { createEventBudget, SOFT_BYTES, TAIL_CHARS };
