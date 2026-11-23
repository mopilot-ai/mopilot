// The Host's spend counter (plan U5): each finished turn's tokens at list price, totalled per chat and per day in the owner's time zone, kept in the data dir, and the check that stops the next turn from starting over a limit. A running turn is never cut.
import fs from 'node:fs';
import path from 'node:path';
import { costOf, priceFor } from '../../shared/host/prices.mjs';
import { dayKey, limitLine } from '../../shared/host/spend.mjs';
import { HostRefusal } from './hostFs.mjs';

const FILE = 'spend.json';
/** The chats whose totals are kept; the oldest go first, the day's total is not theirs. */
const MAX_CHATS = 5000;

/**
 * @param {object} o
 * @param {string} [o.dataDir] where the totals are kept; without one they last for this run
 * @param {() => any} o.limits the effective `spend` block of the policy (`{}` when none)
 * @param {() => number} [o.now]
 * @param {(chatId: string, patch: Record<string, unknown>) => void} o.state publishes a patch to a chat's state lane
 * @param {(m: string) => void} o.report
 * @param {Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync'>} [o.io]
 */
export function createSpend({ dataDir, limits, now = Date.now, state, report, io = fs }) {
  const file = dataDir ? path.join(dataDir, FILE) : null;
  /** @type {{ day: { key: string, usd: number, unpriced: number }, chats: Record<string, { usd: number, unpriced: number }> }} */
  let totals = { day: { key: '', usd: 0, unpriced: 0 }, chats: {} };
  if (file) {
    try {
      const raw = JSON.parse(String(io.readFileSync(file, 'utf8')));
      if (raw?.day && typeof raw.day.key === 'string' && raw.chats && typeof raw.chats === 'object') totals = raw;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT')
        report(`spend: the stored totals could not be read, so they start again (${/** @type {Error} */ (error).message})`);
    }
  }
  /** The model a chat last asked for, for a turn whose usage names none. @type {Map<string, string>} */
  const picks = new Map();
  /** Chats a limit stopped, so raising it can clear them. @type {Set<string>} */
  const limited = new Set();

  const save = () => {
    if (!file) return;
    io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    io.writeFileSync(tmp, JSON.stringify(totals), { mode: 0o600 });
    io.renameSync(tmp, file);
  };
  /** The day's total, started again when the owner's calendar day changed. */
  const today = () => {
    const key = dayKey(now(), limits().tz);
    if (totals.day.key !== key) totals.day = { key, usd: 0, unpriced: 0 };
    return totals.day;
  };
  const chatOf = (/** @type {string} */ chatId) => (totals.chats[chatId] ??= { usd: 0, unpriced: 0 });
  /** The limit a chat is over, if any: the day's first, then its own. @param {string} chatId */
  const overOf = (chatId) => {
    const cfg = limits();
    const day = today();
    if (typeof cfg.dayUsd === 'number' && day.usd >= cfg.dayUsd)
      return /** @type {const} */ ({ key: 'dayUsd', limitUsd: cfg.dayUsd, spentUsd: day.usd });
    const chat = totals.chats[chatId];
    if (typeof cfg.chatUsd === 'number' && chat && chat.usd >= cfg.chatUsd)
      return /** @type {const} */ ({ key: 'chatUsd', limitUsd: cfg.chatUsd, spentUsd: chat.usd });
    return null;
  };
  /** Tells the chat's lane its spend, and its attention when a limit started or stopped holding it. @param {string} chatId */
  const publish = (chatId) => {
    const over = overOf(chatId);
    const was = limited.has(chatId);
    if (over) limited.add(chatId);
    else limited.delete(chatId);
    state(chatId, { spend: lane(chatId), ...(over ? { attention: { kind: 'limit' } } : was ? { attention: null } : {}) });
  };
  /** @param {string} chatId */
  const lane = (chatId) => ({ usd: round(totals.chats[chatId]?.usd ?? 0), limitUsd: limits().chatUsd ?? null });

  return {
    /** The model a chat asked for with its message, kept for a turn that does not name one. @param {string} chatId @param {string | undefined} model */
    notePick(chatId, model) {
      if (model) picks.set(chatId, model);
    },
    /**
     * Adds a finished turn: its tokens at list price when its model is priced; otherwise (no report, or a model not in the table) it counts as unpriced and adds nothing.
     * @param {string} chatId @param {any} usage the turn's usage in ACP's names, with `model` when the harness knows it
     */
    record(chatId, usage) {
      const day = today();
      const chat = chatOf(chatId);
      const cost = usage && typeof usage === 'object' ? costOf(usage, priceFor(usage.model ?? picks.get(chatId), limits().prices)) : null;
      if (cost === null) {
        day.unpriced += 1;
        chat.unpriced += 1;
      } else {
        day.usd += cost;
        chat.usd += cost;
      }
      const ids = Object.keys(totals.chats);
      if (ids.length > MAX_CHATS) for (const id of ids.slice(0, ids.length - MAX_CHATS)) delete totals.chats[id];
      save();
      publish(chatId);
    },
    /** Refuses a turn that would start over a limit: `spend_limit` with the key, the limit and what is spent. @param {string} chatId */
    check(chatId) {
      const over = overOf(chatId);
      if (!over) return;
      limited.add(chatId);
      state(chatId, { attention: { kind: 'limit' } });
      throw new HostRefusal('spend_limit', limitLine(over.key, over.limitUsd), over);
    },
    /** Whether a limit holds the chat now: its next waiting message stays queued. @param {string} chatId */
    holds(chatId) {
      if (overOf(chatId) === null) return false;
      // remembered, so a raised limit finds it and sends the message it held
      limited.add(chatId);
      return true;
    },
    /** The policy changed (a limit raised or removed): a chat that was stopped and is not now has its attention cleared. @returns {string[]} the chats a limit no longer holds, whose waiting message may go */
    reevaluate() {
      const before = [...limited];
      for (const chatId of before) publish(chatId);
      return before.filter((chatId) => !limited.has(chatId));
    },
    /** A chat's totals go with the chat; the day's stay. @param {string} chatId */
    forget(chatId) {
      delete totals.chats[chatId];
      picks.delete(chatId);
      limited.delete(chatId);
      save();
    },
    /** The `spend` block of `host.status`: the day's total, its limit and how many turns were unpriced. */
    status() {
      const day = today();
      return { dayUsd: round(day.usd), dayLimitUsd: limits().dayUsd ?? null, unpriced: day.unpriced };
    },
    /** A chat's spend lane. @param {string} chatId */
    lane,
  };
}

/** Cents of precision are enough to show; the sum itself is kept whole. @param {number} usd */
const round = (usd) => Math.round(usd * 1e4) / 1e4;
