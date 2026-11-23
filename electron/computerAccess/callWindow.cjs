// Computer access (#1364): which remote calls are fresh. A call carries an id and the time it was issued; the host
// refuses one issued too long ago (or too far ahead of its clock) and one whose id it has seen, so a call can't be
// replayed across connections even though each connection's frames already can't be. Each paired device has its own
// window (CallWindow per device), so one device can neither use up the room nor take another device's call ids.

/** How old (or how far in the future) a call may be. */
const CALL_SKEW_MS = 60_000;
/** A call id: what a client may use (a UUID fits). */
const CALL_ID = /^[A-Za-z0-9_-]{8,64}$/;

class CallWindow {
  /** @param {{ now?: () => number, skewMs?: number, max?: number }} [o] */
  constructor(o = {}) {
    this.now = o.now ?? Date.now;
    this.skewMs = o.skewMs ?? CALL_SKEW_MS;
    this.max = o.max ?? 10_000;
    /** call id -> when it was seen; kept until it would be refused as stale anyway */
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }

  /**
   * Whether a call with this id, issued at `issuedAt`, may run: 'ok' (and the id is now seen), 'malformed',
   * 'stale', 'replayed' or 'busy' (more fresh ids than it keeps: a fresh id is never forgotten to make room).
   * @param {unknown} callId @param {unknown} issuedAt
   * @returns {'ok' | 'malformed' | 'stale' | 'replayed' | 'busy'}
   */
  accept(callId, issuedAt) {
    if (typeof callId !== 'string' || !CALL_ID.test(callId) || typeof issuedAt !== 'number' || !Number.isFinite(issuedAt))
      return 'malformed';
    const now = this.now();
    if (Math.abs(now - issuedAt) > this.skewMs) return 'stale';
    this.#prune(now);
    if (this.seen.has(callId)) return 'replayed';
    if (this.seen.size >= this.max) return 'busy';
    this.seen.set(callId, now);
    return 'ok';
  }

  #prune(now) {
    // ids are seen in time order, so the oldest are first; one kept past twice the skew can't be fresh again
    for (const [id, at] of this.seen) {
      if (now - at <= 2 * this.skewMs) break;
      this.seen.delete(id);
    }
  }
}

module.exports = { CallWindow, CALL_SKEW_MS };
