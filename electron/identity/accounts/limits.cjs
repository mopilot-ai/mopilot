// Usage limits on the Codex pool: when an account counts as out, and which login a usage reading or a limited turn belongs to.
const { noteIgnored } = require('../../ignored.cjs');
const { limitInfo } = require('./records.cjs');
const { DEFAULT_ID } = require('./providers.cjs');
const { AccountCliLogin } = require('./cliLogin.cjs');
const LIMITS_STALE_MS = 5 * 60_000;
/** @typedef {import('../codexAccounts.cjs').Account} Account */

/** @typedef {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} Accounts */

// App-server readings (account/rateLimits/updated) name no account. They belong to the login the main
// app-server holds, and to none while it moves to another (switchTo sets the account before apply()
// finishes). A limited turn belongs to the login it started on. These methods keep no state of their own:
// accounts, pins, the applied login, the running turns' logins (turnLogins) and when each account's usage is
// read again (usageRefresh, identity/contract/usageRefresh.cjs) belong to Accounts.
class AccountLimits extends AccountCliLogin {
  /**
   * A turn failed on a usage limit: move its account and authorize the prepared main continuation.
   * @this {Accounts}
   * @param [ranOn] the login the turn started on, when known (no relay: identity/accounts/limits.cjs)
   */
  async onTurnLimit(threadId, ranOn = null, turnId = undefined) {
    const pin = threadId && this.pins.get(threadId);
    const served = (ranOn && this.get(ranOn)) || (pin && this.get(pin.id)) || this.active();
    if (served) this.markLimited(served);
    if (!this.state.autoSwitch) return;
    // At most three automatic continues per chat in ten minutes, so a stuck backend can't loop.
    const recent = (this.resumes.get(threadId) || []).filter((t) => Date.now() - t < 10 * 60_000);
    if (recent.length >= 3) return this.notifyLimit(threadId);
    const continueChat = this.prepareContinue(threadId, turnId);
    // stale usage only lowers the ranking quality; candidates() still works
    await this.refreshUsage(
      this.candidates(served).map((a) => a.id),
      LIMITS_STALE_MS,
    ).catch((error) => noteIgnored('read Codex account usage before moving a chat', error));
    if (!this.state.autoSwitch) return;
    // A spread pool behind the relay routes the chat by its pin; otherwise the app-server itself must
    // move, and an account it can't move to (a failed token refresh) is skipped, as in failover().
    const spread = this.relay && this.state.pool === 'spread';
    const prevPin = threadId ? this.pins.get(threadId) : undefined;
    /** @type {Account | null} */
    let next = null;
    for (const c of this.candidates(served)) {
      if (threadId) this.pins.set(threadId, { id: c.id, at: Date.now() });
      if (spread) {
        next = c;
        break;
      }
      try {
        await this.switchTo(c.id);
        next = c;
        break;
      } catch (error) {
        // this candidate failed: try the next; the exhausted notice follows when none works
        noteIgnored('move a Codex chat to another account', error);
      }
    }
    if (!next) {
      // never announce a move that didn't happen: the chat stays where it was
      if (threadId) {
        if (prevPin) this.pins.set(threadId, prevPin);
        else this.pins.delete(threadId);
      }
      if (!this.exhaustedNoticeAt) {
        this.exhaustedNoticeAt = Date.now();
        setTimeout(() => (this.exhaustedNoticeAt = 0), 30 * 60_000);
        this.notice({ kind: 'exhausted' });
      }
      return;
    }
    if (!this.state.autoSwitch) return;
    this.resumes.set(threadId, [...recent, Date.now()]);
    this.notice({ kind: 'resume', threadId, from: served?.email ?? null, to: next.email });
    continueChat();
  }

  /** @this {Accounts} */
  limited(a) {
    const l = a.limits;
    return !!l?.reached && (!l.resetsAt || l.resetsAt * 1000 > Date.now());
  }
  /** Why an account can't serve a chat right now. */
  /** @this {Accounts} */
  unavailableReason(a) {
    return a.status === 'expired' ? 'expired' : this.limited(a) ? 'limit' : 'unavailable';
  }
  /**
   * @this {Accounts}
   * @param {number | null} [resetsAt] seconds, when the refusal says
   */
  markLimited(a, resetsAt = null) {
    const l = a.limits || {};
    const resets = resetsAt || l.resetsAt || null;
    // the window that resets then is the one used up (the refusal names no window, only when it lifts)
    const full = (w) => (w && resets && w.resetsAt && Math.abs(w.resetsAt - resets) <= 60 ? { ...w, usedPercent: 100 } : (w ?? null));
    const primary = full(l.primary);
    const secondary = full(l.secondary);
    const used = primary?.usedPercent === 100 || secondary?.usedPercent === 100 ? 100 : (l.used ?? null);
    a.limits = { ...l, primary, secondary, used, reached: true, resetsAt: resets, at: Date.now() };
    this.usageRefresh.limited(a.id, resets ? resets * 1000 : null);
    this.changedSoon();
  }
  /**
   * A reading a live turn carried (response headers, the app-server's push): the timer's next read waits from it, and
   * one that says the account is out moves that read to the reset (identity/contract/usageRefresh.cjs).
   * @this {Accounts}
   */
  noteLiveLimits(a) {
    if (!a.limits) return;
    this.usageRefresh.noteLive(a.id, a.limits.at);
    if (a.limits.reached) this.usageRefresh.limited(a.id, a.limits.resetsAt ? a.limits.resetsAt * 1000 : null);
  }
  /** Usage windows the backend reports on every response (x-codex-primary-used-percent, …). */
  /** @this {Accounts} */
  noteUsageHeaders(a, h) {
    const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
    const win = (k) => {
      const used = num(h[`x-codex-${k}-used-percent`]);
      if (used == null) return undefined;
      const after = num(h[`x-codex-${k}-reset-after-seconds`]);
      return {
        usedPercent: used,
        windowDurationMins: num(h[`x-codex-${k}-window-minutes`]),
        resetsAt: num(h[`x-codex-${k}-reset-at`]) ?? (after != null ? Math.floor(Date.now() / 1000) + after : null),
      };
    };
    const p = win('primary');
    const s = win('secondary');
    if (p === undefined && s === undefined) return;
    a.limits = limitInfo({ primary: p ?? a.limits?.primary ?? null, secondary: s ?? a.limits?.secondary ?? null });
    this.noteLiveLimits(a);
    this.changedSoon();
  }

  /**
   * The login the main app-server holds, or null while a switch or (re)connect is still applying one.
   * Before any apply (a restart with no window open) it holds the CLI's own login, which it reads itself. The CLI login
   * folded into an added account (cliLogin.cjs) is that account: one quota (#1312).
   * @this {Accounts}
   */
  heldLogin() {
    const held = (/** @type {string | null} */ id) => (id && this.same?.[id]) || id;
    if (this.pendingApply || (this.applied && held(this.applied) !== this.state.active)) return null;
    const id = held(this.applied ?? (this.mainMode === 'managed' ? DEFAULT_ID : null));
    return id ? this.get(id) : null;
  }
  /**
   * The login that serves a thread, for the usage windows its chat shows: behind the relay the thread's routing pin (a pool of
   * one passes requests through to the held login); without the relay the held login. Null when that cannot be told: an
   * unpinned thread in a pool, or the held login moving to another.
   * @this {Accounts}
   * @returns {Account | null}
   */
  servingLogin(threadId) {
    if (!this.relay) return this.heldLogin();
    const pin = threadId ? this.pins.get(threadId) : null;
    const pinned = pin && this.get(pin.id);
    if (pinned) return pinned;
    return this.subscriptions().length < 2 ? this.heldLogin() : null;
  }
  /** A usage reading the main app-server pushed (no relay): it is the held login's, or nobody's. */
  /** @this {Accounts} */
  onAppServerUsage(snap) {
    const a = this.heldLogin();
    if (!a || !snap || (snap.limitId && snap.limitId !== 'codex')) return;
    a.limits = limitInfo({ ...snap, primary: snap.primary ?? a.limits?.primary, secondary: snap.secondary ?? a.limits?.secondary });
    this.noteLiveLimits(a);
    this.changed();
    // failover confirms the limit with the login's own usage before it moves, and reports its own outcome
    if (a.limits?.reached) this.failover('limit').catch((error) => noteIgnored('move to another Codex account at its limit', error));
  }
  /** Remembers the login a turn starts on (no relay: behind it the turn's routing pin says). */
  /** @this {Accounts} */
  noteTurnStarted(turnId) {
    if (this.relay || !turnId) return;
    const id = this.heldLogin()?.id ?? null;
    this.turnLogins.set(turnId, id);
    if (id) this.usageRefresh.used(id);
  }
  /** Another login took the account's place: its usage, and when that was read, no longer apply; it is read at once. */
  /** @this {Accounts} */
  forgetUsage(a) {
    a.limits = null;
    this.usageRefresh.clear(a.id);
  }
  /**
   * @this {Accounts}
   * @param {Record<string, unknown>} [params]
   */
  async readUsage(a, params = {}) {
    // The main app-server caches limits from all relayed chats. Even its active login's cached
    // reading can belong to another account; use the account's own home for every usage read.
    const current = this.usageRefresh.capture(a.id);
    const sc = this.sidecar(a);
    try {
      return await sc.call('account/rateLimits/read', params);
    } catch (e) {
      if (!current() || !/401|unauthori|token/i.test(String(e.message))) throw e;
      await this.refresh(a);
      if (!current()) throw e;
      return sc.call('account/rateLimits/read', params);
    }
  }
  /** Reset cards always use the selected account's private app-server, even during pool switches. */
  /** @this {Accounts} */
  resetAccount(id) {
    const a = this.get(id);
    if (!a || (a.kind || 'chatgpt') !== 'chatgpt' || a.mopilot) throw new Error('Sign in to a ChatGPT subscription account to use resets.');
    return a;
  }
  /** Reads reset details without letting a retired login replace current quota. @this {Accounts} */
  async resetCredits(id) {
    const a = this.resetAccount(id);
    const current = this.usageRefresh.capture(id);
    const previous = a.limits;
    const r = await this.readUsage(a, { excludeResetCreditDetails: false });
    if (!current()) throw new Error('The login changed during its reset-card read.');
    const snap = r?.rateLimitsByLimitId?.codex ?? r?.rateLimits;
    // Preserve newer headers/polls and last-known quota, as ordinary usage reads do.
    if (
      this.get(id) === a &&
      a.limits === previous &&
      snap &&
      (!snap.limitId || snap.limitId === 'codex') &&
      (snap.primary || snap.secondary || snap.rateLimitReachedType)
    ) {
      a.limits = limitInfo(snap);
      this.changed();
    }
    return r;
  }

  /**
   * Read ChatGPT accounts' usage through their own sidecars, each only when due (identity/contract/usageRefresh.cjs):
   * `how` is the trigger, or the most a reading may age (ms). Overlapping reads of one account share a request,
   * and an account whose read fails backs off without holding up the others.
   * @this {Accounts}
   * @param {string[]} [ids] every ChatGPT account when omitted
   * @param {import('../contract/usageRefresh.cjs').UsageReason | number} [how]
   */
  async refreshUsage(ids, how = 'background') {
    // the CLI's own login may have changed in a terminal: that is news even when nothing is due
    const before = JSON.stringify(this.view());
    this.syncDefault();
    const list = this.state.accounts.filter((a) => (a.kind || 'chatgpt') === 'chatgpt' && (!ids || ids.includes(a.id)));
    const when = typeof how === 'number' ? { reason: /** @type {const} */ ('now'), maxAge: how } : { reason: how };
    const results = await Promise.all(
      list.map((a) => {
        const current = this.usageRefresh.capture(a.id);
        return this.usageRefresh
          .refresh(a.id, { ...when, hot: this.usageRefresh.hot(a.id, this.state.active), measuredAt: a.limits?.at }, async () => {
            const previous = a.limits;
            const r = await this.readUsage(a);
            if (!current()) return;
            const snap = r?.rateLimitsByLimitId?.codex ?? r?.rateLimits;
            // A response header (or a newer poll) received during this read is more recent.
            // An unavailable reading must not erase the last known usage either.
            if (
              a.limits === previous &&
              snap &&
              (!snap.limitId || snap.limitId === 'codex') &&
              (snap.primary || snap.secondary || snap.rateLimitReachedType)
            )
              a.limits = limitInfo(snap);
            if (a.status !== 'ok' && a.status !== 'expired') this.setStatus(a, 'ok');
            return { measuredAt: a.limits?.at };
          })
          .catch((e) => {
            if (current() && String(e.message) !== 'expired') a.error = String(e.message || e).slice(0, 200);
            return { read: current() };
          });
      }),
    );
    // a tick that found nothing due (and no change of the CLI's login) changes nothing
    if (results.some((r) => r.read) || JSON.stringify(this.view()) !== before) this.changed();
    return this.view();
  }
  /**
   * The login a running turn is on, without forgetting it, as the request ledger names it (electron/ledger/codexTap.cjs):
   * the turn's own login, or behind the relay the thread's routing pin.
   * @this {Accounts}
   * @returns {{ id: string, email: string | null, verified: true, pay: 'plan' | 'key' | 'gateway' } | null}
   */
  turnAccount(threadId, turnId) {
    const id = this.relay ? this.pins.get(threadId)?.id : this.turnLogins.get(turnId);
    const a = id ? this.get(id) : null;
    // the pool's logins are named by the credentials they signed in with, never by a shared config file
    const pay = a?.kind === 'apiKey' ? (a.mopilot ? 'gateway' : 'key') : 'plan';
    return a ? { id: a.id, email: a.email ?? null, verified: true, pay } : null;
  }
  /** The login a turn that just ended started on, if known; forgets the turn. */
  /** @this {Accounts} */
  endTurn(turnId) {
    const id = this.turnLogins.get(turnId);
    this.turnLogins.delete(turnId);
    return id ?? null;
  }
}

module.exports = { AccountLimits, LIMITS_STALE_MS };
