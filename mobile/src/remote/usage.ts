// Defensive account usage reads bound to one paired computer and connection generation.
import { bad, capabilities, needs, num, rec, str, type Owned } from './client';
import { USAGE_READ_FRESH_MS } from '../../../shared/claudeRateLimit.mjs';

export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  resetsText: string | null;
  at: number;
  stale: boolean;
};
export type UsageAccount = { harness: string; account: string; label: string; active: boolean; state: string; windows: UsageWindow[] };
const STATES = ['available', 'unavailable', 'unsupported', 'signin'];

export function parseUsage(raw: unknown): UsageAccount[] {
  const r = rec(raw);
  if (r?.scope !== 'local' || !Array.isArray(r.accounts)) return bad('usage');
  return r.accounts.map((item) => {
    const a = rec(item);
    if (!a || !str(a.harness) || !str(a.account) || !str(a.label) || !STATES.includes(String(a.state)) || !Array.isArray(a.windows))
      return bad('an account’s usage');
    const windows = a.windows.map((item) => {
      const w = rec(item);
      const used = num(w?.usedPercent);
      const at = num(w?.at);
      if (!w || !str(w.label) || used === null || used > 100 || at === null || typeof w.stale !== 'boolean') return bad('a usage window');
      if (w.resetsAt !== null && num(w.resetsAt) === null) return bad('a usage reset');
      return {
        label: w.label as string,
        usedPercent: used,
        resetsAt: w.resetsAt as number | null,
        resetsText: str(w.resetsText),
        at,
        stale: w.stale,
      };
    });
    if (a.state === 'available' && !windows.length) return bad('usage windows');
    return {
      harness: a.harness as string,
      account: a.account as string,
      label: a.label as string,
      active: a.active === true,
      state: a.state as string,
      windows,
    };
  });
}

export async function loadUsage(request: Owned, refresh = false) {
  needs(await capabilities(request), 'usage.get', 'view usage');
  return parseUsage(await request('usage.get', { refresh }));
}

/** Dispose or replace a screen's reader to retire every pending success and failure. */
export function usageReader(request: Owned, publish: (accounts: UsageAccount[] | null, error: string | null, busy: boolean) => void) {
  let live = true;
  let seq = 0;
  return {
    async refresh(force = false) {
      if (!live) return;
      const mine = ++seq;
      publish(null, null, true);
      try {
        const accounts = await loadUsage(request, force);
        if (live && seq === mine) publish(accounts, null, false);
      } catch (error) {
        if (live && seq === mine) publish(null, error instanceof Error ? error.message : 'Could not read usage. Try again.', false);
      }
    },
    dispose() {
      live = false;
    },
  };
}

/** Past resets invalidate the old percentage; never turn an old exhausted window into a fresh 100% left. */
export function usageLines(w: UsageWindow, now = Date.now()): { value: string; detail: string } {
  if (w.resetsAt !== null && w.resetsAt * 1000 <= now) return { value: 'Refresh needed', detail: 'Reset since last read' };
  const stale = w.stale || !w.at || now - w.at > USAGE_READ_FRESH_MS;
  const reset = w.resetsAt
    ? `Resets ${new Date(w.resetsAt * 1000).toLocaleString()}`
    : w.resetsText
      ? `Resets ${w.resetsText}`
      : 'Reset time unavailable';
  return { value: `${Math.max(0, 100 - Math.round(w.usedPercent))}% left${stale ? ' · Last known' : ''}`, detail: reset };
}
