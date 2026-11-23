// Computer History's activity entries (#1363): contiguous samples of the same app and title (or site, path and title) become one entry with a start and an end, cut at a gap and at local midnight, so each entry belongs to one day file.

/** How often the recorder samples, and how long one sample counts for. */
const SAMPLE_MS = 5000;
/** A pause longer than this between samples starts a new entry. */
const GAP_MS = 15000;

/**
 * @typedef {import('./policy.cjs').Activity} Activity
 * @typedef {Activity & { start: number, end: number }} Entry
 */

/** The local day an instant falls on, as YYYY-MM-DD. */
function dayKey(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Whether a string is a day key (a real calendar date). */
function isDayKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Sorts day keys newest first: they are fixed-width dates, so comparing them as text orders them by day. */
const newestDayFirst = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? 1 : a > b ? -1 : 0);

/** The first instant of the local day after the one `ms` is in. */
function nextMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** @param {Activity} a @param {Activity} b */
const same = (a, b) => a.bundleId === b.bundleId && a.app === b.app && a.title === b.title && a.site === b.site && a.path === b.path;

/**
 * One more sample at `at`: the open entry grows, or it is closed and a new one opens.
 * @param {Entry | null} open
 * @param {Activity} activity
 * @param {number} at
 * @returns {{ open: Entry, closed: Entry | null }}
 */
function extend(open, activity, at) {
  if (open && same(open, activity) && at >= open.end - SAMPLE_MS && at - open.end <= GAP_MS && dayKey(open.start) === dayKey(at)) {
    // a sample never runs past midnight: the next day's file starts with its own entry
    return { open: { ...open, end: Math.min(at + SAMPLE_MS, nextMidnight(at)) }, closed: null };
  }
  return { open: { ...activity, start: at, end: Math.min(at + SAMPLE_MS, nextMidnight(at)) }, closed: open };
}

/**
 * An entry read back from disk, or null when it is not one.
 * @param {unknown} raw
 * @returns {Entry | null}
 */
function readEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const str = (v) => typeof v === 'string';
  if (!str(r.bundleId) || !str(r.app) || !str(r.title)) return null;
  if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || /** @type {number} */ (r.end) < /** @type {number} */ (r.start))
    return null;
  if ((r.site !== undefined && !str(r.site)) || (r.path !== undefined && !str(r.path))) return null;
  /** @type {Entry} */
  const e = {
    bundleId: r.bundleId,
    app: r.app,
    title: r.title,
    start: /** @type {number} */ (r.start),
    end: /** @type {number} */ (r.end),
  };
  if (r.site !== undefined) {
    e.site = /** @type {string} */ (r.site);
    e.path = /** @type {string} */ (r.path ?? '/');
  }
  return e;
}

module.exports = { SAMPLE_MS, GAP_MS, dayKey, isDayKey, newestDayFirst, nextMidnight, extend, readEntry };
