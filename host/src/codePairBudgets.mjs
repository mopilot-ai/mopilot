// The Host's ONE durable run budget per code offer (R2b, #5576): each offer id gets exactly one `createRunBudget`, restored from and written to `code-pair.json` (0600) before a run begins and when the code is spent, so a Host restart in the middle of a code keeps its count and a spent code stays spent. The code's secret is never written: a restart cancels the offer, and what survives is only that the id is burned (kept for ten minutes, so a relay that replays an old id cannot revive it). The relay mints the ids and is not trusted: an id that is not exactly the relay's own form is never used or written, and a store that lost its memory (a file that could not be read) burns EVERY id for ten minutes, since any id could be an old one.
// @code-pair-budget-owner (tests/codePairBudget.invariant.test.ts: only a file with this marker may make a run budget)
import fs from 'node:fs';
import path from 'node:path';
import { OFFER_ID, createRunBudget } from '../../shared/host/codePair.mjs';

/** How long a finished offer's count is kept after its last change, and how long a store that lost its memory burns every id. */
export const KEEP_MS = 10 * 60 * 1000;
/** Most offers kept at once: a Host makes one at a time, so more is a loop. */
const MAX_KEPT = 64;

/** @typedef {{ started: number, spent: boolean, at: number }} Kept */

/**
 * @param {object} o
 * @param {string} o.file the store's path (the Host's data directory)
 * @param {() => number} [o.now]
 * @param {(file: string, text: string) => void} [o.write] writes the whole file or throws (a test seam; the default writes a temporary file beside it and renames it)
 */
export function createCodePairBudgets({ file, now = Date.now, write = writeAtomic }) {
  /** @type {Map<string, ReturnType<typeof createRunBudget>>} */
  const budgets = new Map();
  const loaded = load(file, now);
  /** What is kept, by offer id: a Map, so no id is a name on a prototype. @type {Map<string, Kept>} */
  const kept = loaded.kept;
  const floor = loaded.floor;
  const flush = () => {
    const cutoff = now() - KEEP_MS;
    for (const [id, k] of kept) if (k.at < cutoff) kept.delete(id);
    // a loop of offers keeps the newest only
    if (kept.size > MAX_KEPT)
      for (const [id] of [...kept].sort((a, b) => a[1].at - b[1].at).slice(0, kept.size - MAX_KEPT)) kept.delete(id);
    write(file, JSON.stringify({ v: 1, floor, offers: Object.fromEntries(kept) }));
  };
  // a store that was set aside remembers it, so a restart inside the ten minutes does not forget it (best effort: the floor also holds in memory)
  if (loaded.setAside) {
    try {
      flush();
    } catch {
      // the floor holds in memory; the next write tries again
      budgets.clear();
    }
  }
  return {
    /**
     * The offer's budget: the same object for the same id, so a second one (a second chance the code does not have) cannot be made. What was kept for this id comes back with it. An id that is not the relay's form is refused; while the store has no memory (`pausedUntil`) every id comes back spent.
     * @param {string} offerId
     */
    forOffer(offerId) {
      if (typeof offerId !== 'string' || !OFFER_ID.test(offerId)) throw new Error('That is not an offer id.');
      const have = budgets.get(offerId);
      if (have) return have;
      const record = kept.get(offerId);
      const paused = !record && now() < floor;
      const budget = createRunBudget({
        ...(record
          ? { restore: { started: record.started, spent: record.spent } }
          : paused
            ? { restore: { started: 0, spent: true } }
            : {}),
        persist: ({ started, spent }) => {
          const before = kept.get(offerId);
          kept.set(offerId, { started, spent, at: now() });
          try {
            flush();
          } catch (error) {
            // not written, so not counted: the run does not start and a later try sees what the file says
            if (before) kept.set(offerId, before);
            else kept.delete(offerId);
            throw error;
          }
        },
      });
      budgets.set(offerId, budget);
      return budget;
    },
    /** Whether an id is kept as used or burned (a relay replaying it must not get a fresh code). @param {string} offerId */
    burned: (offerId) => (kept.get(offerId)?.spent ?? false) || budgets.get(offerId)?.burned === true,
    /** Until when this store burns every id it does not know (0: not at all): the time after a file that could not be read. The service says "pairing by code is paused for a few minutes" until then. */
    pausedUntil: () => (now() < floor ? floor : 0),
    /** What this store holds (for tests and the status). */
    size: () => kept.size,
  };
}

/** @param {string} file @param {string} text */
function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

/**
 * What the file keeps. A file that cannot be read as this is set aside (never trusted, never deleted) and the store starts empty with a floor: no id is believed new for ten minutes. An id that is not the relay's form is dropped; an entry that is not exactly this shape is a spent code.
 * @param {string} file @param {() => number} now @returns {{ kept: Map<string, Kept>, floor: number, setAside: boolean }}
 */
function load(file, now) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { kept: new Map(), floor: 0, setAside: false };
    return setAside(file, now);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.v !== 1 || !parsed.offers || typeof parsed.offers !== 'object' || Array.isArray(parsed.offers)) return setAside(file, now);
    /** @type {Map<string, Kept>} */
    const out = new Map();
    for (const [id, k] of Object.entries(parsed.offers)) {
      if (!OFFER_ID.test(id)) continue;
      const v = /** @type {any} */ (k);
      out.set(
        id,
        Number.isInteger(v?.started) && typeof v?.spent === 'boolean'
          ? { started: v.started, spent: v.spent, at: Number.isFinite(v.at) ? v.at : now() }
          : { started: 99, spent: true, at: now() },
      );
    }
    return { kept: out, floor: Number.isFinite(parsed.floor) ? parsed.floor : 0, setAside: false };
  } catch {
    return setAside(file, now);
  }
}

/** @param {string} file @param {() => number} now @returns {{ kept: Map<string, Kept>, floor: number, setAside: boolean }} */
function setAside(file, now) {
  const empty = { kept: new Map(), floor: now() + KEEP_MS, setAside: true };
  try {
    fs.renameSync(file, `${file}.corrupt-${now()}`);
    return empty;
  } catch {
    // a file that cannot be moved is overwritten by the next write
    return empty;
  }
}
