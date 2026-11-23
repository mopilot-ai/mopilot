// When an account's plan usage is read again, for every harness: often for the login in use and logins used
// lately, rarely for idle ones, at once when a surface showing it opens; overlapping reads of one account share
// one request, and an account whose reads fail or are refused backs off on its own, never holding up the others. What a
// live turn reports counts as a reading, and a limit it ran into moves the account's next timed read to the reset.

const MIN = 60_000;
/** How old an account's figures may be before a trigger reads them again, by trigger and by tier. */
const MAX_AGE = {
  background: { hot: 5 * MIN, idle: 60 * MIN },
  surface: { hot: MIN, idle: 15 * MIN },
  now: { hot: 0, idle: 0 },
};
/** A login used this recently is read as often as the one in use. */
const RECENT_MS = 30 * MIN;
const BACKOFF_BASE_MS = 2 * MIN;
const BACKOFF_MAX_MS = 60 * MIN;

/** @typedef {'background' | 'surface' | 'now'} UsageReason */
/** @typedef {{ read: boolean, retryAt: number | null }} UsageRefreshResult */

class UsageRefresh {
  /**
   * dueAt: the account is at a limit until then, so a timer reads it at that time and not before (0: no limit known)
   * @type {Map<string, { inflight: Promise<UsageRefreshResult> | null, attemptedAt: number, measuredAt: number, usedAt: number, failures: number, until: number, dueAt: number }>}
   */
  #accounts = new Map();

  /** @param {{ now?: () => number }} [o] */
  constructor(o = {}) {
    this.now = o.now ?? Date.now;
  }

  #entry(account) {
    let e = this.#accounts.get(account);
    if (!e) {
      e = { inflight: null, attemptedAt: 0, measuredAt: 0, usedAt: 0, failures: 0, until: 0, dueAt: 0 };
      this.#accounts.set(account, e);
    }
    return e;
  }

  /** The account served work just now (a turn ran on it): it is read as often as the one in use for a while. */
  used(account) {
    this.#entry(account).usedAt = this.now();
  }

  /** A live turn reported the account's figures, measured at `measuredAt`: the next timed read waits from then. */
  noteLive(account, measuredAt) {
    const e = this.#entry(account);
    e.measuredAt = Math.max(e.measuredAt, measuredAt);
    // measured at or after the reset it was held for: the read that reset was waiting for is this one
    if (e.dueAt && measuredAt >= e.dueAt) e.dueAt = 0;
  }

  /**
   * A turn on the account ran into its limit: nothing a timer reads can be news before `resetsAt` (ms), and right
   * after it the figures are out of date, so the timer reads it then, whatever its tier or a backoff says. With no
   * known reset it is read at the next tick after any backoff, which learns the reset; a reset already known is kept.
   * @param {string} account
   * @param {number | null} resetsAt
   */
  limited(account, resetsAt) {
    const e = this.#entry(account);
    const now = this.now();
    if (resetsAt && resetsAt > now) e.dueAt = resetsAt;
    // not before a backoff ends: a refusal with nothing to wait for is no reason to ask a refusing source again
    else if (!(e.dueAt > now)) e.dueAt = Math.max(now, e.until);
  }

  /** In use, or used lately. */
  hot(account, active) {
    return account === active || this.now() - (this.#accounts.get(account)?.usedAt ?? 0) < RECENT_MS;
  }

  /** When the account may be read again after a failure or refusal, or null when it isn't backing off. */
  retryAt(account) {
    const until = this.#accounts.get(account)?.until ?? 0;
    return until > this.now() ? until : null;
  }

  /** Capture this login generation: clear/forget retires its continuations and publications. */
  capture(account) {
    const e = this.#entry(account);
    return () => this.#accounts.get(account) === e;
  }

  /** It works again: a new generation is due at once; older reads cannot hold it back. */
  clear(account) {
    const e = this.#accounts.get(account);
    if (e) this.#accounts.set(account, { ...e, inflight: null, failures: 0, until: 0, attemptedAt: 0, measuredAt: 0, dueAt: 0 });
  }

  /** The account is gone: nothing is kept for it. A read still in flight settles for its own callers only. */
  forget(account) {
    this.#accounts.delete(account);
  }

  #backoff(e) {
    e.until = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** e.failures);
    e.failures++;
  }

  /**
   * Read the account's usage when it is due: none is in flight (else that one is shared), it isn't backing off,
   * and its figures (as measured, or as last attempted) are older than the trigger allows for its tier.
   * `read` resolves with when the figures it got were measured, and whether the source refused to measure them
   * afresh (an answer from an old cache); either a refusal or a rejection backs this account off. A rejection is
   * passed on to every caller sharing the read.
   * @param {string} account
   * @param {{ reason: UsageReason, hot: boolean, maxAge?: number, measuredAt?: number | null }} o maxAge: the caller's own limit
   *   instead of the trigger's; measuredAt: when the figures the caller already holds were measured
   * @param {() => Promise<{ measuredAt?: number | null, refused?: boolean } | void>} read
   * @returns {Promise<UsageRefreshResult>}
   */
  refresh(account, o, read) {
    const e = this.#entry(account);
    if (e.inflight) return e.inflight;
    const now = this.now();
    const atReset = e.dueAt > 0 && e.dueAt <= now;
    if (e.until > now && !atReset) return Promise.resolve({ read: false, retryAt: e.until });
    const known = Math.max(e.attemptedAt, e.measuredAt, o.measuredAt ?? 0);
    const held = e.dueAt > now && o.reason === 'background';
    if (!atReset && (held || now - known < (o.maxAge ?? MAX_AGE[o.reason][o.hot ? 'hot' : 'idle'])))
      return Promise.resolve({ read: false, retryAt: null });
    e.attemptedAt = now;
    if (atReset) e.dueAt = 0;
    const current = this.capture(account);
    const retired = { read: false, retryAt: null };
    const job = Promise.resolve()
      .then(() => (current() ? read() : undefined))
      .then(
        (r) => {
          if (!current()) return retired;
          if (r?.measuredAt) e.measuredAt = Math.max(e.measuredAt, r.measuredAt);
          if (r?.refused) this.#backoff(e);
          else Object.assign(e, { failures: 0, until: 0 });
          return { read: true, retryAt: this.retryAt(account) };
        },
        (error) => {
          if (!current()) return retired;
          this.#backoff(e);
          throw error;
        },
      )
      .finally(() => {
        if (e.inflight === job) e.inflight = null;
      });
    e.inflight = job;
    return job;
  }
}

/** A trigger from another process (IPC): one of the known reasons, else a surface opening. @returns {UsageReason} */
const usageReason = (reason) =>
  typeof reason === 'string' && Object.hasOwn(MAX_AGE, reason) ? /** @type {UsageReason} */ (reason) : 'surface';

module.exports = { UsageRefresh, usageReason, MAX_AGE, RECENT_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS };
