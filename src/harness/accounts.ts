// One account shape for every harness, so the profile menu, model picker and Settings read accounts
// the same way whichever harness owns them. Pure: the store-bound hook and actions live in select.ts.
import type { AccountsState, ClaudeAccountsState, ManagedAccount } from '../lib/native';
import { formatCredits } from '../lib/credits';
import { COPY } from './copy';
import { HARNESS_LABEL, claudePlanLabel, type HarnessId, type HarnessStatus, type UsageWindow } from './types';
import { managedWindows, RESET_SINCE_READ, resetAhead, until, USAGE_STALE_MS, usedNow, windowLabel, windowLimited } from './usageWindows';
import { usageOfLogin } from './claudeUsage';

export { until };

/**
 * What an account has left, whichever harness reports it. `source`: pushed by the harness (live),
 * read on a schedule (polled), taken from a CLI's text (parsed), or not known (none). MoPilot has no
 * quota window; it carries the credit balance.
 */
export interface UsageSnapshot {
  windows: UsageWindow[];
  source: 'live' | 'polled' | 'parsed' | 'none';
  at: number | null;
  fetchState?: 'loading' | 'success' | 'unavailable' | 'error';
  fetchError?: string | null;
  /** MoPilot credits, in millionths of a dollar */
  balanceMicros?: number | null;
}

const NO_USAGE: UsageSnapshot = { windows: [], source: 'none', at: null };

export interface Account {
  /** unique within its harness */
  id: string;
  harness: HarnessId;
  email: string | null;
  /** "Pro Lite", "Claude Max 20×", "API key" */
  plan: string | null;
  kind: 'subscription' | 'apiKey';
  status: 'ok' | 'expired' | 'signin';
  usage: UsageSnapshot;
  /** percent of usage left in the tightest window, when known */
  left: number | null;
  /** usage limit reached; `resetsAt` is unix seconds */
  limited: { resetsAt: number | null } | null;
  /** the account its email names is not confirmed to be this login (another client renamed it) */
  unverified?: true;
  /** signed in as another account (its email) than the one it was added as: this email */
  addedAs?: string;
  /** signed out because its config folder moved: signing in again confirms it (electron/identity/contract/accountDirs.cjs) */
  reconfirm?: true;
}

export interface HarnessAccounts {
  harness: HarnessId;
  /** the account new chats on this harness use */
  active: Account | null;
  accounts: Account[];
  /** the harness keeps several accounts side by side */
  multi: boolean;
  /** logins left out because they are the same server account as a listed one: folded id -> listed id (#1312) */
  same?: Record<string, string>;
}

export function planName(p: string) {
  const map: Record<string, string> = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
  };
  const key = p.replace(/^self_serve_/, '').replace(/_/g, '');
  for (const k of Object.keys(map).sort((a, b) => b.length - a.length))
    if (key.endsWith(k)) return (p.includes('business') && k !== 'business' ? 'Business ' : '') + map[k];
  return p;
}

/** The most used of the windows whose figure is known now; null when none is (each reset since its reading). */
const usedOfWindows = (w: readonly { usedPercent: number; resetsAt?: number | null }[]) => {
  const known = w.map(usedNow).filter((u): u is number => u != null);
  return known.length ? Math.max(...known) : null;
};

const leftOf = (used: number | null | undefined) => (used == null ? null : Math.max(0, 100 - Math.round(used)));

/** One quota window of a rate-limit snapshot, as far as it is read here. */
type LimitWindowLike = { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null };
/** The app-server's RateLimitSnapshot, as far as it is read here. */
export type LimitSnapshotLike = {
  limitId?: string | null;
  primary?: LimitWindowLike | null;
  secondary?: LimitWindowLike | null;
  planType?: string | null;
};
/** account/rateLimits/read's response (GetAccountRateLimitsResponse), as far as it is read here. */
export type RateLimitsLike<S extends LimitSnapshotLike = LimitSnapshotLike> = {
  rateLimits?: S | null;
  rateLimitsByLimitId?: Partial<Record<string, S>> | null;
};

/** The general Codex quota, never an arbitrary model-specific limit. */
export function codexLimitSnapshot<S extends LimitSnapshotLike>(rateLimits: RateLimitsLike<S> | null | undefined): S | null {
  const snap = rateLimits?.rateLimitsByLimitId?.codex ?? rateLimits?.rateLimits;
  return snap && (!snap.limitId || snap.limitId === 'codex') ? snap : null;
}

function liveUsed(rateLimits: RateLimitsLike | null | undefined): number | null {
  const snap = codexLimitSnapshot(rateLimits);
  const windows = [snap?.primary, snap?.secondary].filter(Boolean) as LimitWindowLike[];
  return usedOfWindows(windows.map((w) => ({ usedPercent: w.usedPercent ?? 0, resetsAt: w.resetsAt })));
}

function fromManaged(a: ManagedAccount, balanceMicros: number | null | undefined): Account {
  const l = a.limits;
  const windows = managedWindows(l);
  // what is used now: a window past its reset started over, so its figure is not known (a reading without windows
  // can't say which did)
  const used = windows.length ? usedOfWindows(windows) : (l?.used ?? null);
  // each window of the last reading; a reading without them still says how much is used
  const shown = windows.length || used == null ? windows : [{ label: 'Usage', usedPercent: used, resetsAt: l?.resetsAt ?? null }];
  const usage: UsageSnapshot = a.mopilot
    ? { windows: [], source: 'polled', at: null, balanceMicros: balanceMicros ?? null }
    : a.kind === 'apiKey' || !shown.length
      ? NO_USAGE
      : { windows: shown, source: 'polled', at: l?.at || null };
  const limited = l?.reached && resetAhead(l.resetsAt) ? { resetsAt: l.resetsAt } : null;
  return {
    id: a.id,
    harness: 'codex',
    email: a.email,
    plan: a.mopilot ? MOPILOT_PLAN : a.kind === 'apiKey' ? 'API key' : a.planType ? planName(a.planType) : null,
    kind: a.kind === 'apiKey' ? 'apiKey' : 'subscription',
    status: a.status,
    usage,
    left: a.kind === 'apiKey' ? null : leftOf(used),
    limited,
  };
}

/** Codex: the account manager's pool, or the app-server's own login when there is no pool yet. */
export function codexAccounts(s: {
  accounts: AccountsState;
  account: { type?: string; email?: string | null; planType?: string | null } | null;
  rateLimits: RateLimitsLike | null;
  requiresAuth?: boolean;
  balanceMicros?: number | null;
}): HarnessAccounts {
  const pool = s.accounts.accounts;
  if (pool.length) {
    const activeId = s.accounts.active ?? pool[0].id;
    // App-server notifications have no account identity. With the relay they can describe any
    // chat's account, and after a switch they can still describe the previous login.
    const accounts = pool.map((a) => fromManaged(a, s.balanceMicros));
    return {
      harness: 'codex',
      active: accounts.find((a) => a.id === activeId) ?? null,
      accounts,
      multi: true,
      same: s.accounts.same ?? {},
    };
  }
  if (!s.account) return { harness: 'codex', active: null, accounts: [], multi: true };
  const live = liveUsed(s.rateLimits);
  const apiKey = s.account.type === 'apiKey';
  const snap = codexLimitSnapshot(s.rateLimits);
  // each window as the harness status names it (select.ts codexStatus), so the reset of each shows on every surface
  const windows: UsageWindow[] = [snap?.primary, snap?.secondary].flatMap((w) =>
    w ? [{ label: windowLabel(w.windowDurationMins), usedPercent: Math.round(w.usedPercent ?? 0), resetsAt: w.resetsAt ?? null }] : [],
  );
  const one: Account = {
    id: 'default',
    harness: 'codex',
    email: s.account.email ?? null,
    plan: apiKey ? 'API key' : s.account.planType ? planName(s.account.planType) : null,
    kind: apiKey ? 'apiKey' : 'subscription',
    status: s.requiresAuth ? 'signin' : 'ok',
    usage: apiKey || live == null ? NO_USAGE : { windows, source: 'live', at: null },
    left: apiKey ? null : leftOf(live),
    limited: null,
  };
  return { harness: 'codex', active: one, accounts: [one], multi: true };
}

const usedOf = (u: HarnessStatus['usage'] | null | undefined) => (u ? usedOfWindows(u.windows) : null);
/** The CLI's /usage text, parsed (D-65); a key bills per use and has none. */
const snapshotOf = (u: HarnessStatus['usage'] | null | undefined, apiKey: boolean): UsageSnapshot =>
  apiKey || !u
    ? NO_USAGE
    : {
        windows: u.windows,
        source: u.windows.length ? 'parsed' : 'none',
        at: u.at || null,
        ...(u.fetchState ? { fetchState: u.fetchState, fetchError: u.fetchError ?? null } : {}),
      };
const limitOf = (u: HarnessStatus['usage'] | null | undefined) => {
  const w = u?.windows.find(windowLimited);
  return w ? { resetsAt: w.resetsAt ?? null } : null;
};

/**
 * Whether Claude Code's key setting (billing.ts useClaudeKey) bills every login: a key, MoPilot credits, or the
 * shell's cloud provider. False when each login bills as itself; null before the setting is known.
 */
export const claudeKeyForAll = (k: { mode: string; cloudEnv: boolean; cloudDetected: boolean } | null | undefined): boolean | null =>
  k ? k.mode !== 'subscription' || (k.cloudEnv && k.cloudDetected) : null;

/**
 * Claude Code: its account list (the CLI's own login first), with usage per account. The harness
 * status describes the account in use, so that one takes its live state from there.
 */
export function claudeAccounts(
  st: HarnessStatus,
  pool?: ClaudeAccountsState | null,
  usage: Record<string, HarnessStatus['usage']> = {},
  /** the key setting bills every login (billing.ts claudeKeyForAll); null: not known yet, so the status says for all */
  keyForAll: boolean | null = null,
): HarnessAccounts {
  const apiKey = st.state === 'apikey';
  // the status's key state is the active login's: it covers the others only when the key setting bills them all
  const allKeyed = keyForAll ?? apiKey;
  if (pool?.accounts.length) {
    // the login in use is listed while it is someone: signed in, or known (an email, a plan, a moved folder). One with
    // nothing known, signed out or still being checked, is no account: the harness says "Not signed in" or "Checking…",
    // as below and as Codex does (#1867)
    const someone = (a: (typeof pool.accounts)[number]) =>
      st.state === 'ready' || st.state === 'apikey' || !!(st.email || st.plan || a.subscriptionType || a.reconfirm);
    const accounts: Account[] = pool.accounts
      .filter((a) => a.loggedIn || a.email || (a.id === pool.active && someone(a)))
      .map((a) => {
        const isActive = a.id === pool.active;
        // never another server account's figures, whether its own reading or the status of the login in use (#1582)
        const u = usageOfLogin(usage[a.id] ?? (isActive ? st.usage : null), a);
        const signedOut = isActive ? st.state === 'signin' : !a.loggedIn;
        // billed per use: by the key setting, as the active login, or as a Console login of its own
        const keyed = allKeyed || (isActive && apiKey);
        return {
          id: a.id,
          harness: 'claude',
          email: a.email ?? (isActive ? (st.email ?? null) : null),
          plan: keyed
            ? // the login in use says who the key bills ("API key · your cloud account"); the others are keyed alike
              (isActive && apiKey && st.plan) || 'API key'
            : ((isActive ? st.plan : null) ?? claudePlanLabel(a.subscriptionType, a.organizationType, a.rateLimitTier)),
          // a Console login bills per use like a key
          kind: keyed || /api.?key|console/i.test(a.authMethod ?? '') ? 'apiKey' : 'subscription',
          status: signedOut ? 'signin' : 'ok',
          usage: snapshotOf(u, keyed),
          left: keyed ? null : leftOf(usedOf(u)),
          limited: keyed ? null : limitOf(u),
          ...(a.identity === 'unverified' ? { unverified: true as const } : {}),
          ...(a.identity === 'mismatch' && a.addedAs ? { addedAs: a.addedAs } : {}),
          ...(signedOut && a.reconfirm ? { reconfirm: true as const } : {}),
        };
      });
    const known = st.state === 'ready' || st.state === 'apikey' || st.state === 'signin' || accounts.some((a) => a.status === 'ok');
    if (!known) return { harness: 'claude', active: null, accounts: [], multi: true };
    return { harness: 'claude', active: accounts.find((a) => a.id === pool.active) ?? null, accounts, multi: true, same: pool.same ?? {} };
  }
  // before the account list arrives: the CLI's login, read from the harness status
  const known = st.state === 'ready' || st.state === 'apikey' || (st.state === 'signin' && !!(st.email || st.plan));
  if (!known) return { harness: 'claude', active: null, accounts: [], multi: true };
  const used = usedOf(st.usage);
  const one: Account = {
    id: 'default',
    harness: 'claude',
    email: st.email ?? null,
    plan: st.plan,
    kind: apiKey ? 'apiKey' : 'subscription',
    status: st.state === 'signin' ? 'signin' : 'ok',
    usage: snapshotOf(st.usage, apiKey),
    left: apiKey ? null : leftOf(used),
    limited: apiKey ? null : limitOf(st.usage),
  };
  return { harness: 'claude', active: one, accounts: [one], multi: true };
}

/** The managed Codex account that bills MoPilot credits through the gateway. */
export const MOPILOT_PLAN = 'MoPilot credits';

/** A login known to be signed out or expired (a record without a status is not judged). */
const lapsed = (a: Pick<Account, 'status'>) => !!a.status && a.status !== 'ok';

/** Name for an account in lists: its email, or what it is when there is none. */
export const accountName = (a: Account) =>
  a.unverified
    ? COPY.accounts.unverifiedName
    : (a.email ??
      (a.plan === MOPILOT_PLAN
        ? MOPILOT_PLAN
        : a.kind === 'apiKey'
          ? 'API key'
          : // only a login that is signed in is called one; a lapsed one is named by its harness
            lapsed(a)
            ? `${HARNESS_LABEL[a.harness]} login`
            : 'Signed-in account'));

/**
 * The plan and usage /status reports for a chat: the chat's own account when it differs from the one new chats
 * use, else the harness's (D-65). An account with no reading shows none
 * rather than another account's bars.
 */
export function rowAccountInfo(
  st: HarnessStatus,
  def: Account | null,
  own: Account | null,
): { plan: string | null; usage: HarnessStatus['usage'] } {
  if (!own || !def || own.id === def.id) return { plan: st.plan, usage: st.usage };
  return { plan: own.plan, usage: own.usage.windows.length ? { windows: own.usage.windows, at: own.usage.at ?? 0 } : null };
}

/** The line on the Fast control when the account in use is billed per token, or null (D-57). Codex only: Claude's Fast is billed to extra usage. */
export function fastBillingNote(h: HarnessId, active: { kind: Account['kind'] } | null | undefined): string | null {
  return h === 'codex' && active?.kind === 'apiKey' ? COPY.fast.apiKeyBilling : null;
}

/** Short usage/status text: "62% left","Limit reached · resets in 2h", "Sign-in expired". */
export function accountStatusText(a: Account): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  // its usage is this login's own; only which account it is needs confirming
  if (a.unverified)
    return { text: `${COPY.accounts.unverified} · ${accountStatusText({ ...a, unverified: undefined }).text}`, tone: 'warn' };
  if (a.addedAs) return { text: `${COPY.accounts.otherAccount} · ${accountStatusText({ ...a, addedAs: undefined }).text}`, tone: 'warn' };
  if (a.status === 'expired') return { text: 'Sign-in expired', tone: 'warn' };
  if (a.status === 'signin') return { text: a.reconfirm ? COPY.accounts.reconfirm : 'Signed out', tone: 'warn' };
  if (a.plan === MOPILOT_PLAN)
    return a.usage.balanceMicros != null
      ? { text: `${formatCredits(a.usage.balanceMicros)} left`, tone: 'ok' }
      : { text: 'Balance unknown', tone: 'muted' };
  if (a.kind === 'apiKey') return { text: 'Billed per token', tone: 'muted' };
  // Figures can be old: an idle account is read rarely, and Claude's can be the CLI's cached answer when its usage
  // endpoint refuses. Say how old, on every harness.
  const stale =
    (a.harness === 'claude' && (a.usage.fetchState === 'error' || a.usage.fetchState === 'unavailable')) ||
    (a.usage.at != null && Date.now() - a.usage.at > USAGE_STALE_MS);
  const updated = stale && a.usage.at ? ` · updated ${Math.max(0, Math.floor((Date.now() - a.usage.at) / 60_000))}m ago` : '';
  if (a.limited)
    return {
      text: (a.limited.resetsAt ? `Limit reached · resets in ${until(a.limited.resetsAt)}` : 'Limit reached') + updated,
      tone: 'warn',
    };
  if (a.left != null) return { text: `${a.left}% left${updated}`, tone: stale ? 'muted' : 'ok' };
  // every window reset since the reading: what is left now is not known until the next one
  if (a.usage.windows.length) return { text: `${RESET_SINCE_READ}${updated}`, tone: 'muted' };
  if (a.harness === 'claude')
    return {
      text:
        a.usage.fetchState === 'loading'
          ? 'Fetching usage…'
          : a.usage.fetchState === 'error'
            ? 'Usage refresh failed'
            : a.usage.fetchState === 'unavailable'
              ? 'Usage unavailable'
              : 'Usage not loaded',
      tone: 'muted',
    };
  return { text: 'Usage unknown', tone: 'muted' };
}

/** Needs the user's attention: shown as the dot on the rail avatar. */
export const needsAttention = (a: Account) => a.status !== 'ok';

/**
 * The login to sign in again when a chat's own Claude login has lapsed: the account that chat is on,
 * not the one new chats use (D-43). A chat with no account of its own, or one that was removed, uses the one in use.
 */
export function signInAccountFor(
  chats: Record<string, { id: string }>,
  pool: { active: string; accounts: { id: string }[] },
  chatId: string,
): string {
  const own = chats[chatId]?.id;
  return own && (own === 'default' || pool.accounts.some((a) => a.id === own)) ? own : pool.active;
}

/** The CLI's own login has not been read since the app started, so its `loggedIn` is not an answer (main's `checked`; an older main never says). */
export const loginUnread = (a: { checked?: boolean }) => a.checked === false;

/**
 * What the signed-out banner shows (D-43): the login in play (the open chat's own, else the one new chats
 * use), whether it has lapsed, and the other logins that are still signed in. null: nothing to show.
 */
export function claudeSignedOut(
  status: { state: string; email?: string | null; plan?: string | null },
  pool: { active: string; accounts: { id: string; email: string | null; loggedIn: boolean; checked?: boolean }[] },
  chats: Record<string, { id: string }>,
  chatId: string | null,
): { login: string; email: string | null; others: { id: string; email: string | null }[] } | null {
  const login = chatId ? signInAccountFor(chats, pool, chatId) : pool.active;
  const row = pool.accounts.find((a) => a.id === login);
  const isActive = login === pool.active;
  const out = isActive ? status.state === 'signin' : !!row && !row.loggedIn && !loginUnread(row);
  const email = (isActive ? status.email : null) ?? row?.email ?? null;
  // outside a chat only a login that has been signed in before is worth a banner
  if (!out || !(chatId || email || status.plan)) return null;
  return { login, email, others: pool.accounts.filter((a) => a.id !== login && a.loggedIn).map((a) => ({ id: a.id, email: a.email })) };
}

/**
 * The second line of the sidebar's account button: the plan of each harness's account in use ("Max · Pro"), or how
 * many accounts there are once there are more than two. Null with none signed in.
 */
export function profileSummary(harnesses: readonly { active: Account | null; accounts: readonly Account[] }[]): string | null {
  // a signed-out login names no account (a fresh Mac's CLI login is one): the avatar's warning dot covers it
  const signedIn = (a: Account | null): a is Account => !!a && a.status !== 'signin';
  const total = harnesses.reduce((n, h) => n + h.accounts.filter(signedIn).length, 0);
  if (total > 2) return `${total} accounts`;
  const plans = harnesses.flatMap((h) => (signedIn(h.active) ? [h.active.plan ?? accountName(h.active)] : []));
  return plans.length ? plans.join(' · ') : null;
}
