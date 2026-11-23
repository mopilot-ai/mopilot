// Claude Code plan usage on main's schedule (identity/contract/usageRefresh.cjs): a /usage query for a login only when it is
// due, the last answer otherwise, for every window alike, with when its figures were measured. Beside it, what live
// turns reported for each login (rate_limit_event), so a window opened later, or none at all, still has the newer figures.
const { clock } = require('../../platform/ports/clock.cjs');
const { UsageRefresh, usageReason } = require('../../identity/contract/usageRefresh.cjs');
const { claudeLiveUsage, claudeLimitResetsAt, usageTextLimit } = require('../../../shared/claudeRateLimit.mjs');
const { messageOf } = require('../../ignored.cjs');
const { serverIdOf } = require('./loginIdentity.cjs');

/**
 * An answer measured this long before it was asked for came from the CLI's own cache: the CLI asks its usage
 * endpoint once its cache is a minute old, so it was refused (a 429 the CLI remembers) and the login backs off.
 */
const CACHED_ANSWER_MS = 2 * 60_000;
/**
 * /usage prints its windows under these headings. When the usage endpoint refuses (a 429 it remembers for up to an
 * hour) and the login's folder has no cached figures, it prints only the local breakdown: a refusal too (#1582).
 */
const FIGURES = /^\s*Current[ \t]+(session|week)\b[\s\S]*?(?<![-.\d])\d+(?:\.\d+)?\s*%[ \t]*used/im;

/**
 * @param {{ read: (bin: string, account: string | undefined) => Promise<string>, measuredAt: (configId: string) => number | null,
 *   configIdOf: (account: string | undefined) => string, active: () => string, policy?: InstanceType<typeof UsageRefresh>, now?: () => number,
 *   accountOf?: (login: string) => string | null, loginsOf?: (login: string) => string[], onLeft?: (login: string, left: number, measuredAt: number, resetsAt: number | null) => void }} o
 *   onLeft: what a login's own /usage read says is left of its plan (percent), when the CLI measured it and when a used-up window starts over, for the switch
 *   policy's ranking and for holding back a login with nothing left
 *   measuredAt: when the CLI last fetched the usage of the login in that config folder (ClaudeAccounts.usageFetchedAt);
 *   accountOf: the server account a login is (#1294), null when not known; loginsOf: the signed-in logins that are the
 *   same server account as this one, itself included (#1312): they share one quota
 */
function createUsageSchedule(o) {
  const policy = o.policy ?? new UsageRefresh();
  const now = o.now ?? (() => clock.now());
  /** config folder id -> the last answer read there */
  const last = new Map();
  /**
   * What turns reported, by server account (by login while that is not known): two logins of one account are one
   * quota. Window by window, each as its latest event said, measured then.
   */
  const live = new Map();
  const liveKey = (login) => {
    const account = o.accountOf?.(login);
    return account ? `account:${account}` : `login:${login}`;
  };
  const sharing = (login, /** @type {string | null} */ startedAs = null) => {
    if (startedAs && o.accountOf?.(login) !== startedAs) return [];
    const logins = o.loginsOf?.(login) ?? [];
    return logins.includes(login) ? logins : [login, ...logins];
  };

  /**
   * The login's usage as of its last read, reading it first when the trigger finds it due. `cached`: no read ran
   * for this call; `retryAt`: the login is backing off until then.
   * @param {string} bin
   * @param {string | undefined} account
   * @param {unknown} [reason] 'background' | 'surface' | 'now'; anything else counts as a surface opening
   */
  async function usage(bin, account, reason) {
    const login = account ?? o.active();
    const id = o.configIdOf(login);
    const current = policy.capture(id);
    // the server account the login is once a read settles: the CLI login's read names it (harness/claude/loginIdentity.cjs)
    const accountNow = () => o.accountOf?.(id) ?? null;
    let result;
    try {
      result = await policy.refresh(id, { reason: usageReason(reason), hot: policy.hot(id, o.configIdOf(o.active())) }, async () => {
        const asked = now();
        const text = await o.read(bin, login);
        // the reading is as old as the CLI's last fetch, which a cached answer predates
        const measuredAt = o.measuredAt(id) ?? now();
        if (current()) {
          last.set(id, { state: 'success', text, measuredAt, account: accountNow() });
          // a login's own folder (subscription mode): a key's read says nothing of a login's quota
          const read = id === login ? usageTextLimit(text, now()) : null;
          if (read) o.onLeft?.(id, read.left, measuredAt, read.resetsAt);
        }
        return { measuredAt, refused: measuredAt < asked - CACHED_ANSWER_MS || !FIGURES.test(text) };
      });
    } catch (error) {
      if (current()) last.set(id, { state: 'error', error: messageOf(error), account: accountNow() });
      result = { read: true, retryAt: policy.retryAt(id) };
    }
    if (!current()) return { state: 'retired' };
    const { account: readAs = null, ...answer } = last.get(id) ?? { state: 'error', error: 'Claude Code usage has not been read yet.' };
    // a login's own folder (subscription mode): a key's never answers with a login's figures
    const own = id === login;
    const heard = own ? live.get(liveKey(id)) : undefined;
    return {
      ...answer,
      // the server account the figures are of, as it was when they were read (an answer kept from before a sign-in as
      // another account is that account's): a window drops figures of another account (#1582)
      account: own ? readAs : null,
      cached: !result.read,
      ...(result.retryAt ? { retryAt: result.retryAt } : {}),
      ...(heard ? { live: heard } : {}),
    };
  }

  /**
   * A turn on the login reported its usage (a rate_limit_event's rate_limit_info). Windows it names replace the ones
   * heard before; a refusal marks its window used up and moves the login's next timed read to the reset.
   * @param {string} account the login the process ran on, never a key
   * @param {string | null} [startedAs] the server account that login was when the process started, when known: its
   *   figures are that account's, whatever the login is now
   */
  function heard(account, info, startedAs = null) {
    const at = now();
    const reading = claudeLiveUsage(info, at);
    const logins = sharing(account, startedAs);
    if (reading.windows.length) {
      const key = startedAs ? `account:${startedAs}` : liveKey(account);
      const byLabel = new Map((live.get(key)?.windows ?? []).map((w) => [w.label, w]));
      for (const w of reading.windows) byLabel.set(w.label, { ...w, at });
      live.set(key, { windows: [...byLabel.values()], status: reading.status, at });
      for (const l of logins) policy.noteLive(l, at);
    }
    if (info?.status === 'rejected') for (const l of logins) policy.limited(l, claudeLimitResetsAt(info));
  }

  return {
    usage,
    // These name a login, never a key: its own folder id is the login id (configIdOf in subscription mode).
    /** A turn ran on this login: it is read as often as the one in use for a while. */
    used: (account) => policy.used(account),
    /**
     * The login reads signed in again: what it failed with before no longer holds it back, nor what it reported while
     * its account was not known (a known account's quota is the account's, and a new sign-in names its own).
     */
    clear: (account) => {
      policy.clear(account);
      last.delete(account);
      live.delete(`login:${account}`);
    },
    /** The login was removed: nothing is kept for it. */
    forget: (account) => {
      policy.forget(account);
      last.delete(account);
      live.delete(`login:${account}`);
    },
    heard,
    /** A turn on the login was refused for its limit with no figures (an assistant `rate_limit` error): it is read at the next tick. */
    limited: (account, startedAs = null) => {
      for (const l of sharing(account, startedAs)) policy.limited(l, null);
    },
  };
}

/**
 * Which server account each login is, and which signed-in logins share it, from the logins main holds (none yet: each
 * login is its own).
 * @param {() => InstanceType<typeof import('./accounts.cjs').ClaudeAccounts> | null | undefined} accounts
 */
function loginAccounts(accounts) {
  return {
    /** @param {string} login */
    accountOf: (login) => {
      const a = accounts();
      return a ? serverIdOf(a, login) : null;
    },
    /** @param {string} login */
    loginsOf: (login) => {
      const same = accounts()?.sameAccounts() ?? {};
      const shown = same[login] ?? login;
      return [shown, ...Object.keys(same).filter((id) => same[id] === shown)];
    },
  };
}

module.exports = { createUsageSchedule, loginAccounts, CACHED_ANSWER_MS };
