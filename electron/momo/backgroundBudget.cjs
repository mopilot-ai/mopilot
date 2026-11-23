// The tokens MoMo's background work spends in a day (#2999 P2, #2139 P3): the memory pass, the search aliases (of past
// chats and of saved facts) and P4's nudge check each add their estimated tokens (prompt and reply) here, and each checks left() before it
// starts; one total cap a day, and a cap per kind, so a long backfill of aliases never takes the memory pass's share. Kept sealed with MoMo's memory
// (<momo dir>/background-tokens.json, deleted by Reset with the memory files); only today's counts are kept, by the
// local day. Settings shows usage(): the day's cap and each kind's share.
const path = require('node:path');
const { SealedJson } = require('../gateway/sealedFile.cjs');

/** @typedef {'memory' | 'aliases' | 'nudges'} BudgetKind */

/** The most tokens MoMo's background work may spend in a day, all kinds together. */
const DAILY_TOKENS = 200_000;
/** Each kind's own most in a day. */
const KIND_TOKENS = Object.freeze({ memory: 120_000, aliases: 100_000, nudges: 20_000 });

/** The local day `ms` falls on, as YYYY-MM-DD. */
function dayOf(/** @type {number} */ ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The saved counts as today's: another day's (or anything unreadable) counts as none spent. */
function shapeOf(/** @type {unknown} */ v, /** @type {number} */ now) {
  const o = /** @type {any} */ (v);
  /** @type {Record<string, number>} */
  const tokens = {};
  if (o && typeof o === 'object' && o.day === dayOf(now) && o.tokens && typeof o.tokens === 'object')
    for (const [k, n] of Object.entries(o.tokens))
      if (Object.hasOwn(KIND_TOKENS, k) && Number.isFinite(n) && n > 0) tokens[k] = Math.floor(n);
  return { day: dayOf(now), tokens };
}

/**
 * @param {{ file: string, safeStorage: any, now?: () => number, daily?: number, caps?: Record<BudgetKind, number> }} o
 *   file: background-tokens.json in MoMo's folder
 */
function createBackgroundBudget({ file, safeStorage, now = Date.now, daily = DAILY_TOKENS, caps = KIND_TOKENS }) {
  const sealed = new SealedJson({ file, safeStorage, now, shape: shapeOf });
  /** Today's counts; none when the file can't be read (encryption off: nothing is spent past this run's own adds). */
  let unsaved = shapeOf(null, now());
  /** Whether the last read found the day's counts (false: only this run's own adds are known). */
  let readable = true;
  const read = () => {
    try {
      const v = sealed.read();
      readable = true;
      return v;
    } catch {
      readable = false;
      const today = shapeOf(unsaved, now());
      unsaved = today;
      return today;
    }
  };
  return {
    /** Adds `tokens` to `kind`'s count for today. */
    async spend(/** @type {BudgetKind} */ kind, /** @type {number} */ tokens) {
      const n = Math.floor(tokens);
      if (!Object.hasOwn(caps, kind) || !(n > 0)) return;
      const add = (/** @type {{ tokens: Record<string, number> }} */ v) => {
        v.tokens[kind] = (v.tokens[kind] ?? 0) + n;
      };
      try {
        await sealed.change(add);
      } catch {
        unsaved = shapeOf(unsaved, now());
        add(unsaved);
      }
    },
    /** Today's tokens per kind. @returns {Record<BudgetKind, number>} */
    byKind() {
      const { tokens } = read();
      return { memory: tokens.memory ?? 0, aliases: tokens.aliases ?? 0, nudges: tokens.nudges ?? 0 };
    },
    /** What `kind` may still spend today: the smaller of its own cap's rest and the day's. */
    left(/** @type {BudgetKind} */ kind) {
      const spent = this.byKind();
      const total = spent.memory + spent.aliases + spent.nudges;
      return Math.max(0, Math.min(daily - total, (Object.hasOwn(caps, kind) ? caps[kind] : 0) - (spent[kind] ?? 0)));
    },
    /** The caps, for Settings. */
    limits: () => ({ daily, ...caps }),
    /**
     * The day's cap and each kind's share, with what each spent today (Settings › MoMo › Brain › Background memory);
     * today null when the counts can't be read now, never a number that isn't true.
     */
    usage() {
      const spent = this.byKind();
      const today = (/** @type {number} */ n) => (readable ? n : null);
      return {
        daily: { cap: daily, today: today(spent.memory + spent.aliases + spent.nudges) },
        memory: { cap: caps.memory, today: today(spent.memory) },
        aliases: { cap: caps.aliases, today: today(spent.aliases) },
      };
    },
  };
}

/** The budget kept in MoMo's folder `dir` (one per app: the memory pass and the aliases are handed the same one). */
const budgetIn = (/** @type {string} */ dir, /** @type {any} */ safeStorage) =>
  createBackgroundBudget({ file: path.join(dir, 'background-tokens.json'), safeStorage });

module.exports = { createBackgroundBudget, budgetIn, dayOf, DAILY_TOKENS, KIND_TOKENS };
