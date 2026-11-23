// What main has seen of each Claude Code login (a limit, a lapsed sign-in, how much is left), for the switch
// policy (identity/contract/switch.cjs). One owner for these marks, so every write is scoped and every lapse has an exit:
// what a key or MoPilot credits said is never recorded against the subscription login (the key failed, not the
// login), and a login that works again (it answered, a verified check passed, its status reads signed in
// again) is no longer counted as signed out.

const { LIMIT_HOLD_MS } = require('./switch.cjs');
const { claudeLimitResetsAt, planUtilization, USAGE_READ_FRESH_MS } = require('../../../shared/claudeRateLimit.mjs');

/** @typedef {{ limitedUntil?: number, expired?: boolean, left?: number }} LoginMark */

class LoginMarks {
  /** @type {Map<string, LoginMark>} */
  #marks = new Map();
  /** Logins whose `limitedUntil` a /usage read put on, not a turn: the next read may lift it, and it is not kept for the next run. */
  #heldByRead = new Set();
  #store;

  /**
   * @param {{ load: () => any, save: (marks: Record<string, LoginMark>) => void }} [store] where the marks are kept between runs
   * @param {number} [now] ms: only a limit still running is loaded. A lapse is checked again by the next run, and
   *   what was left is read again by the next /usage, so neither is kept.
   */
  constructor(store, now = Date.now()) {
    this.#store = store;
    for (const [id, m] of Object.entries(store?.load() ?? {}))
      if (typeof m?.limitedUntil === 'number' && m.limitedUntil > now) this.#marks.set(id, { limitedUntil: m.limitedUntil });
  }

  #set(account, mark) {
    this.#marks.set(account, mark);
    const limits = [...this.#marks].flatMap(([id, m]) =>
      m.limitedUntil && !this.#heldByRead.has(id) ? [[id, { limitedUntil: m.limitedUntil }]] : [],
    );
    this.#store?.save(Object.fromEntries(limits));
  }

  /** @returns {LoginMark | undefined} */
  get(account) {
    return this.#marks.get(account);
  }

  /** A copy of every mark, for decideClaudeSwitch: what it marks there stays there. */
  snapshot() {
    return new Map(this.#marks);
  }

  /**
   * A rate-limit event from a process (its rate_limit_info): how much is left, and until when the login is out.
   * The login answered, so a lapse it was marked with is over. Ignored when the process ran on a key (`login` false).
   * @param {{ login: boolean }} scope
   */
  usage(scope, account, info, now) {
    if (!scope.login || !info) return;
    const used = planUtilization(info);
    const { expired: _over, ...mark } = { ...this.#marks.get(account), left: Math.max(0, 100 - Math.round(used * 100)) };
    if (info.status === 'rejected') {
      mark.limitedUntil = claudeLimitResetsAt(info) ?? now + LIMIT_HOLD_MS;
      this.#heldByRead.delete(account);
    }
    this.#set(account, mark);
  }

  /**
   * A reading of what is left (percent) of the login's plan, from its /usage: a key's is never put on the login.
   * A read of nothing left holds the login back as a refused turn does, so a chat starts on another login instead of
   * spending a turn here: until the reset the text printed (`resetsAt`, ms) whatever the age of the read, since a reset
   * not yet reached still lies ahead; without one, for LIMIT_HOLD_MS when the read is fresh (`measuredAt` within
   * USAGE_READ_FRESH_MS of `now`). The next fresh read of something left lifts the hold. A limit a turn reported has its
   * own reset: reads leave it as it is.
   * @param {{ login: boolean }} scope
   * @param {number} [measuredAt] ms
   * @param {number} [now] ms
   * @param {number | null} [resetsAt] ms
   */
  seen(scope, account, left, measuredAt, now, resetsAt) {
    if (!scope.login) return;
    const mark = { ...this.#marks.get(account), left };
    if (now != null) {
      const fresh = measuredAt != null && now - measuredAt <= USAGE_READ_FRESH_MS;
      const until = resetsAt != null && resetsAt > now ? resetsAt : fresh ? now + LIMIT_HOLD_MS : null;
      const byTurn = (mark.limitedUntil ?? 0) > now && !this.#heldByRead.has(account);
      if (left === 0 && until !== null && !byTurn) {
        mark.limitedUntil = until;
        this.#heldByRead.add(account);
      } else if (left > 0 && fresh && this.#heldByRead.delete(account)) delete mark.limitedUntil;
    }
    this.#set(account, mark);
  }

  /** A limit with no known reset time: a login not already held back is held for `holdMs` from `now`. */
  limited(scope, account, now, holdMs) {
    if (!scope.login) return;
    const seen = this.#marks.get(account);
    // what a turn reported is the login's own; a hold a read put on is only a guess at it
    if (this.#heldByRead.delete(account) || !((seen?.limitedUntil ?? 0) > now)) this.#set(account, { ...seen, limitedUntil: now + holdMs });
  }

  /** The login's sign-in lapsed (an authentication error from a process that ran on it). */
  expired(scope, account) {
    if (scope.login) this.#set(account, { ...this.#marks.get(account), expired: true });
  }

  /** The login works again (a verified check passed, or its status reads signed in again): it is no longer signed out. */
  works(account) {
    const seen = this.#marks.get(account);
    if (!seen?.expired) return false;
    const { expired: _over, ...rest } = seen;
    this.#set(account, rest);
    return true;
  }
}

module.exports = { LoginMarks };
