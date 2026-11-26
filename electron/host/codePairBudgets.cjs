// The typed-code budget of pairing by code (R2b, #5576): ONE run budget per typed code, keyed by sha256 of the normalised code, kept for ten minutes (an offer lives five) and restored fail-closed, so quitting and starting again, or typing the code again, never gives it more runs. A store that cannot be read is set aside (never trusted, never deleted) and the store starts empty with a floor: no code is believed new for ten minutes (in memory, and in the file when it can be written), then codes work again.
// @code-pair-budget-owner
const crypto = require('node:crypto');
const { noteIgnored } = require('../ignored.cjs');
const { createRunBudget } = require('../../shared/host/codePair.mjs');

/** How long a typed code's count is kept, and how long a store that lost its memory burns every code that is not in it. */
const KEEP_MS = 10 * 60_000;

/**
 * @param {object} o
 * @param {{ read: () => unknown, write: (value: unknown) => void, setAside: () => void }} o.store the app's own file for it: `read` gives undefined when there is none, `setAside` moves a file that cannot be trusted out of the way
 * @param {() => number} o.now
 */
function createTypedCodeBudgets({ store, now }) {
  /** @type {Map<string, ReturnType<typeof createRunBudget>>} */
  const open = new Map();
  /** What is kept, by hash of the code. @type {Record<string, { started: unknown, spent: unknown, at: unknown }>} */
  let kept = Object.create(null);
  let floor = 0;
  let aside = false;
  try {
    const raw = /** @type {any} */ (store.read());
    if (raw !== undefined) {
      if (raw?.v !== 1 || !raw.codes || typeof raw.codes !== 'object' || Array.isArray(raw.codes)) throw new Error('not a store of counts');
      Object.assign(kept, raw.codes);
      // a floor beyond ten minutes from now (a corrupt or hand-edited file) would spend every new code until then
      floor = Number.isFinite(raw.floor) ? Math.min(raw.floor, now() + KEEP_MS) : 0;
    }
  } catch (error) {
    // the file is no store of counts: it is set aside, and no code is believed new for ten minutes
    noteIgnored('read the counts of pairing by code', error);
    aside = true;
    floor = now() + KEEP_MS;
    try {
      store.setAside();
    } catch (error) {
      // a file that cannot be moved is overwritten by the next write
      noteIgnored('set aside the counts of pairing by code', error);
    }
  }
  /** Drops what ran out: an entry whose age cannot be read is kept (and restored as a spent code). */
  const prune = () => {
    for (const [k, v] of Object.entries(kept)) {
      const at = v && typeof v === 'object' ? v.at : undefined;
      if (typeof at === 'number' && Number.isFinite(at) && now() - at >= KEEP_MS) delete kept[k];
    }
  };
  prune();
  /** Writes the whole store, what ran out dropped (throws when it cannot). */
  const flush = () => {
    prune();
    store.write({ v: 1, floor, codes: kept });
  };
  // a store that was set aside remembers it, so a restart inside the ten minutes does not forget it (best effort: the floor also holds in memory)
  if (aside) {
    try {
      flush();
    } catch (error) {
      // the next write tries again
      noteIgnored('write the counts of pairing by code', error);
    }
  }
  return {
    /**
     * The one budget of a typed code, however many times it is typed. @param {{ hint: string, secret: string }} code
     */
    forCode(code) {
      const key = crypto.createHash('sha256').update(`${code.hint}${code.secret}`).digest('hex');
      const had = open.get(key);
      if (had) return had;
      const entry = kept[key];
      const at = typeof entry?.at === 'number' ? entry.at : now();
      const budget = createRunBudget({
        // a code this store does not know, while it has no memory, is a spent one
        restore: entry !== undefined ? entry : now() < floor ? { started: 0, spent: true } : undefined,
        persist: ({ started, spent }) => {
          const before = kept[key];
          kept[key] = { started, spent, at };
          try {
            flush();
          } catch (error) {
            // not written, so not counted: the run does not start
            if (before) kept[key] = before;
            else delete kept[key];
            throw error;
          }
        },
      });
      open.set(key, budget);
      return budget;
    },
    /** Forgets what ran out, in memory too (a code typed again after ten minutes is a code of a new offer). */
    sweep() {
      flush();
      for (const key of [...open.keys()]) if (!(key in kept)) open.delete(key);
    },
  };
}

module.exports = { createTypedCodeBudgets, KEEP_MS };
