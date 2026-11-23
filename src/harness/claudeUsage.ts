// Claude Code plan usage in the renderer: parsing the /usage text, merging readings and the periodic refresher.

import type { HarnessStatus, UsageReason, UsageWindow } from './types';
import { errorText } from '../lib/ignored';
import { parseUsageText } from '../../shared/claudeUsageText.mjs';
export { parseUsageText } from '../../shared/claudeUsageText.mjs';
import type { Usage, UsageReadResult } from '../../shared/model/native';
export type { Usage, UsageReadResult } from '../../shared/model/native';

/**
 * Two readings are of different accounts: the newer names one and the older names another, or none (it was kept from
 * before readings named their account, so whose it was is not known). Its figures are then dropped, never merged (#1582).
 */
const otherAccount = (prev: Usage, account: string | null | undefined) => !!account && prev?.account !== account;

/**
 * The reading a login's row may show: no figures when the login is known to be another account than the one the
 * reading measured, or than a reading that names none (the CLI's own login can be signed in again as anyone). How
 * its last read went still shows.
 */
export function usageOfLogin(u: Usage | undefined, login: { serverId?: string | null }): Usage {
  if (!u) return null;
  return login.serverId && u.account !== login.serverId ? { ...u, windows: [], at: 0, status: null } : u;
}

/** A login's figures as every surface shows them (its row, the harness status, the limit offer): usageOfLogin. */
export function loginUsage(
  usage: Record<string, Usage>,
  pool: { accounts: readonly { id: string; serverId?: string | null }[] },
  id: string,
): Usage {
  return usageOfLogin(usage[id], pool.accounts.find((a) => a.id === id) ?? {});
}

/**
 * A reading without extra-usage windows (`seven_day_overage_included`): readings saved before those were left out
 * (shared/claudeRateLimit.mjs) still carry one under its raw key, and a merge would keep it for good.
 */
export function withoutExtraUsage(u: Usage): Usage {
  if (!u?.windows.some((w) => /overage/i.test(w.label))) return u;
  return { ...u, windows: u.windows.filter((w) => !/overage/i.test(w.label)) };
}

/**
 * Windows that appear in both sources share a label; the newer reading wins, others are kept. Newer is by
 * when the figures were measured, not when they arrived: /usage can answer from a cache older than a chat's
 * live limits, and none of that answer's windows (a limit since lifted among them) replaces or joins them.
 */
export function mergeUsage(saved: HarnessStatus['usage'], next: HarnessStatus['usage']): HarnessStatus['usage'] {
  const prev = withoutExtraUsage(saved);
  if (!next?.windows.length) return prev ?? next;
  // another account's figures: the reading is the new account's alone
  if (otherAccount(prev, next.account)) return { ...next, status: next.status ?? null, fetchState: 'success', fetchError: null };
  if (prev?.windows.length && prev.at > next.at) {
    // its reset times still hold for a window that resets after the newer reading measured it: the same window
    const resets = new Map(next.windows.map((w) => [w.label, w.resetsAt]));
    const windows = prev.windows.map((w) => {
      const r = resets.get(w.label);
      return w.resetsAt == null && r && r * 1000 > (w.at ?? prev.at) ? { ...w, resetsAt: r } : w;
    });
    return { ...prev, windows, fetchState: 'success', fetchError: null };
  }
  // a window the newer reading lacks keeps the time it was measured
  const byLabel = new Map((prev?.windows ?? []).map((w): [string, UsageWindow] => [w.label, { ...w, at: w.at ?? prev!.at }]));
  for (const w of next.windows) {
    const { at: _measured, ...known } = byLabel.get(w.label) ?? ({} as Partial<UsageWindow>);
    byLabel.set(w.label, { ...known, ...w });
  }
  // a reading that does not know its account (a turn's, before the login's was known) keeps the one already named
  const account = next.account || (prev?.account ?? next.account);
  return {
    windows: [...byLabel.values()],
    status: next.status ?? prev?.status ?? null,
    at: next.at,
    fetchState: 'success',
    fetchError: null,
    ...(account !== undefined ? { account } : {}),
  };
}

/**
 * A failed/loading fetch updates diagnostics without changing the last successful reading, unless the answer is of
 * another account (`account`): then nothing of the old account's is left to show.
 */
export function usageFetchState(
  prev: Usage,
  fetchState: 'loading' | 'unavailable' | 'error',
  fetchError: string | null = null,
  account?: string | null,
): NonNullable<Usage> {
  const kept = otherAccount(prev, account)
    ? { account, windows: [], at: 0, status: null }
    : { windows: prev?.windows ?? [], at: prev?.at ?? 0 };
  return { ...prev, ...kept, fetchState, fetchError, attemptedAt: Date.now() };
}

/**
 * Ask main for each account's usage; main reads only when the reason finds it due and backs a failing login off,
 * so nothing here retries. Callers share requests until they settle, and an answer this window already holds
 * (main's last read, for another window or an earlier tick) changes nothing.
 */
export function createUsageRefresher(o: {
  read: (account: string, reason: UsageReason) => Promise<UsageReadResult>;
  current: (account: string) => Usage;
  noteReading: (account: string, reading: Usage) => void;
  noteFetch: (account: string, state: 'loading' | 'unavailable' | 'error', error?: string, who?: string | null) => void;
}) {
  /** The read's own answer: its figures, or why there are none (the last figures stay while they are the same account's). */
  const noteAnswer = (account: string, result: Exclude<UsageReadResult, { state: 'retired' }>) => {
    const prev = o.current(account);
    const named = result.account !== undefined ? { account: result.account } : {};
    const fail = (state: 'unavailable' | 'error', error: string) => {
      if (prev?.fetchState !== state || prev.fetchError !== error || otherAccount(prev, result.account))
        o.noteFetch(account, state, error, result.account);
    };
    if (result.state === 'error') return fail('error', result.error);
    const parsed = parseUsageText(result.text, result.measuredAt ?? undefined);
    if (!parsed)
      return fail(
        'unavailable',
        result.text.trim() ? 'Claude Code returned an unrecognized usage format.' : 'Claude Code returned no usage data.',
      );
    if (prev?.fetchState !== 'success' || prev.at !== parsed.at || otherAccount(prev, result.account))
      o.noteReading(account, { ...parsed, ...named });
  };
  // Generations outlive map cleanup: a queued "now" can run after its old request's finally.
  const generations = new Map<string, object>();
  const requests = new Map<string, { reason: UsageReason; request: Promise<void>; current: () => boolean }>();
  const refresh = (account: string, reason: UsageReason = 'surface'): Promise<void> => {
    const pending = requests.get(account);
    // the user asking waits for a timer's or a surface's request, then asks itself: main may have answered that one from cache
    if (pending && reason === 'now' && pending.reason !== 'now')
      return pending.request.then(() => (pending.current() ? refresh(account, reason) : undefined));
    if (pending !== undefined) return pending.request;
    // Defer callbacks until the request is registered, including synchronous/reentrant callers.
    const generation = generations.get(account) ?? {};
    generations.set(account, generation);
    const owner = { reason, request: Promise.resolve(), current: () => generations.get(account) === generation };
    const request = Promise.resolve()
      .then(async () => {
        if (!owner.current()) return;
        // "Fetching usage…" only until the first answer: later reads keep showing the last one (or its failure)
        if (!o.current(account)) o.noteFetch(account, 'loading');
        const result = await o.read(account, reason).catch((e): UsageReadResult => ({ state: 'error', error: errorText(e) }));
        if (!owner.current() || result.state === 'retired') return;
        noteAnswer(account, result);
        // a turn's report newer than anything this window holds: merged by when each was measured (mergeUsage)
        const { live } = result;
        if (owner.current() && live?.windows.length && (o.current(account)?.at ?? 0) < live.at)
          o.noteReading(account, result.account !== undefined ? { ...live, account: result.account } : live);
      })
      .finally(() => {
        if (requests.get(account) === owner) requests.delete(account);
      });
    owner.request = request;
    requests.set(account, owner);
    return request;
  };
  return Object.assign(refresh, {
    /** A sign-in replaced this login: pending results and queued promotions belong to the prior login. */
    invalidate(account: string) {
      generations.set(account, {});
      requests.delete(account);
    },
  });
}
