// The Live Activity state a phone shows, kept as counts only: each Mac sends a snapshot of its own chats ({needs, running, kind of the newest
// event, a start time, up to three rows}); the relay keeps the latest snapshot per pair in memory and merges the pairs of one phone into the one
// activity state it pushes through ActivityKit. A row is a kind, a start time, an opaque chat handle and an optional sealed label the phone's
// widget opens with the per-pair title key; diff stats, commands, file names and plan text have no field here, so none can be carried.

export const MAX_ROWS = 3;
export const MAX_COUNT = 99;
/** The longest sealed row label forwarded: a 120-unit title sealed and base64url-encoded is about 560 characters, and three rows must fit APNs's 4 KB. */
export const MAX_ROW_SEALED = 700;
export const MAX_REF = 128;
/** A chat handle and a sealed label are base64url text (what the Mac builds); anything else is refused, so a row cannot carry readable content or escape-inflated bytes. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;
export const STATE_KINDS = ['needs', 'running', 'done'];
/** A snapshot nobody refreshed this long is a Mac that went away; it stops counting. */
export const SNAPSHOT_TTL_MS = 30 * 60_000;
/** After this long without an update the system shows the activity as stale ("updates paused"). */
export const STALE_MS = 20 * 60_000;
/** A "Finished" frame stays on the lock screen this long before the system removes it. */
export const FINISHED_LINGER_MS = 4 * 60_000;

const RANK = { needs: 0, running: 1, done: 2 };
const count = (/** @type {unknown} */ v) =>
  Number.isInteger(v) && /** @type {number} */ (v) >= 0 ? Math.min(/** @type {number} */ (v), MAX_COUNT) : null;
const seconds = (/** @type {unknown} */ v) =>
  Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) < 4_102_444_800 ? /** @type {number} */ (v) : null;

/**
 * Reads a Mac's snapshot field by field: only the known fields are taken, so a field a newer Mac adds is ignored rather than forwarded.
 * @param {any} raw
 * @returns {{ needs: number, running: number, kind: string, since: number, at: number, rows: { kind: string, since: number, ref: string, st?: string }[] } | null} null when a known field is malformed
 */
export function parseSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const needs = count(raw.needs);
  const running = count(raw.running);
  const since = seconds(raw.since);
  const at = seconds(raw.at);
  if (needs === null || running === null || since === null || at === null || !STATE_KINDS.includes(raw.kind)) return null;
  const list = raw.rows === undefined ? [] : raw.rows;
  if (!Array.isArray(list) || list.length > MAX_ROWS) return null;
  const rows = [];
  for (const r of list) {
    const rowSince = seconds(r?.since);
    if (
      rowSince === null ||
      !STATE_KINDS.includes(r?.kind) ||
      typeof r.ref !== 'string' ||
      r.ref.length > MAX_REF ||
      !BASE64URL.test(r.ref)
    )
      return null;
    if (r.st !== undefined && (typeof r.st !== 'string' || r.st.length > MAX_ROW_SEALED || !BASE64URL.test(r.st))) return null;
    rows.push({ kind: r.kind, since: rowSince, ref: r.ref, ...(r.st && { st: r.st }) });
  }
  return { needs, running, kind: raw.kind, since, at, rows };
}

/** Per phone: the latest snapshot of each of its pairs. */
export class ActivityFeed {
  constructor() {
    /** @type {Map<string, Map<string, { snap: NonNullable<ReturnType<typeof parseSnapshot>>, seen: number }>>} */
    this.byPhone = new Map();
  }

  set(
    /** @type {string} */ phone,
    /** @type {string} */ pairId,
    /** @type {NonNullable<ReturnType<typeof parseSnapshot>>} */ snap,
    /** @type {number} */ now,
  ) {
    let pairs = this.byPhone.get(phone);
    if (!pairs) this.byPhone.set(phone, (pairs = new Map()));
    pairs.set(pairId, { snap, seen: now });
  }

  /** Forgets one pair's snapshot, when the pair is removed. */
  forgetPair(/** @type {string} */ pairId) {
    for (const [phone, pairs] of this.byPhone) {
      pairs.delete(pairId);
      if (!pairs.size) this.byPhone.delete(phone);
    }
  }

  /** Drops snapshots nothing refreshed lately, so a long-lived relay keeps none for a Mac that is gone. */
  prune(/** @type {number} */ now) {
    for (const [phone, pairs] of this.byPhone) {
      for (const [pairId, e] of pairs) if (now - e.seen >= SNAPSHOT_TTL_MS) pairs.delete(pairId);
      if (!pairs.size) this.byPhone.delete(phone);
    }
  }

  /**
   * The one state a phone shows: counts added up (capped), the kind of the newest event, the earliest start, the three most urgent rows.
   * @returns {{ needs: number, running: number, kind: string, since: number, rows: { kind: string, since: number, ref: string, st?: string }[] } | null} null when no live snapshot is held
   */
  merged(/** @type {string} */ phone, /** @type {number} */ now) {
    const live = [...(this.byPhone.get(phone)?.values() ?? [])].filter((e) => now - e.seen < SNAPSHOT_TTL_MS).map((e) => e.snap);
    if (!live.length) return null;
    const newest = live.reduce((a, b) => (b.at > a.at ? b : a));
    const starts = live.map((s) => s.since).filter((s) => s > 0);
    const rows = live
      .flatMap((s) => s.rows)
      .sort((a, b) => RANK[/** @type {'needs'} */ (a.kind)] - RANK[/** @type {'needs'} */ (b.kind)] || a.since - b.since)
      .slice(0, MAX_ROWS);
    return {
      needs: Math.min(
        live.reduce((n, s) => n + s.needs, 0),
        MAX_COUNT,
      ),
      running: Math.min(
        live.reduce((n, s) => n + s.running, 0),
        MAX_COUNT,
      ),
      kind: newest.kind,
      since: starts.length ? Math.min(...starts) : 0,
      rows,
    };
  }
}
