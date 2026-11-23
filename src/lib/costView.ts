// What Settings → Accounts & billing → Estimated cost shows, from the request ledger's priced summary (shared/costSummary.mjs via
// window.native.ledger.summary): the range's days, totals by harness and by model, and the dollar text. Every number is an
// estimate at API list price; requests whose model has no list price are counted apart, never as free.
import type { LedgerSummary, LedgerUsageRow } from './native/ledger';

export type CostRange = '7' | '30' | 'all';
export const COST_RANGES: readonly { value: CostRange; label: string }[] = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: 'all', label: 'All recorded' },
];

const pad = (n: number) => String(n).padStart(2, '0');
/** The local day stem `ms` falls on, as the ledger names its day files (electron/ledger/store.cjs dayOf). */
export function dayStem(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The first and last day of a range ending today; an open start for everything recorded. */
export function rangeDays(range: CostRange, now: number): { from?: string; to: string } {
  const to = dayStem(now);
  if (range === 'all') return { to };
  const d = new Date(now);
  d.setDate(d.getDate() - (Number(range) - 1));
  return { from: dayStem(d.getTime()), to };
}

/** "$12.34", "$0.42", "<$0.01" for a small cost that is not zero, "$0.00" for none. */
export function usdText(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export type CostTotal = { key: string; label: string; usd: number; requests: number; unpriced: number; tokens: number };

const tokensOf = (r: LedgerUsageRow) => r.in + r.out + r.cacheRead + r.cacheWrite;

/**
 * The rows summed by harness or by model, the costliest first; a harness is named by `harnessLabel` (the app's registry, which this
 * layer cannot read), a model the ledger could not name is "Unknown model".
 */
export function totalsBy(rows: LedgerUsageRow[], by: 'harness' | 'model', harnessLabel: (id: string) => string = (id) => id): CostTotal[] {
  const out = new Map<string, CostTotal>();
  for (const r of rows) {
    const key = by === 'harness' ? r.harness : (r.model ?? '');
    const label = by === 'harness' ? harnessLabel(r.harness) : r.model || 'Unknown model';
    const t = out.get(key) ?? { key, label, usd: 0, requests: 0, unpriced: 0, tokens: 0 };
    t.requests += r.requests;
    t.tokens += tokensOf(r);
    if (r.usd === null) t.unpriced += r.requests;
    else t.usd += r.usd;
    out.set(key, t);
  }
  return [...out.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.label.localeCompare(b.label));
}

export type CostOverview = { usd: number; requests: number; unpriced: number; planUsd: number; incomplete: boolean };

/** The range's totals: its cost, how much of it ran on a subscription plan, and whether some of its history could not be read. */
export function overviewOf(s: LedgerSummary): CostOverview {
  let usd = 0;
  let requests = 0;
  let unpriced = 0;
  let planUsd = 0;
  for (const r of s.rows) {
    requests += r.requests;
    if (r.usd === null) unpriced += r.requests;
    else {
      usd += r.usd;
      if (r.pay === 'plan') planUsd += r.usd;
    }
  }
  return { usd, requests, unpriced, planUsd, incomplete: s.rollup !== 'ok' || (s.unread?.length ?? 0) > 0 || s.imported === 'unreadable' };
}

/** One bar per day of a 7- or 30-day range, oldest first, with its share of the costliest day (0 to 1); none for all recorded. */
export function dayBars(rows: LedgerUsageRow[], range: CostRange, now: number): { day: string; usd: number; share: number }[] {
  if (range === 'all') return [];
  const byDay = new Map<string, number>();
  for (const r of rows) if (r.usd !== null) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.usd);
  const days: { day: string; usd: number }[] = [];
  const d = new Date(now);
  for (let i = Number(range) - 1; i >= 0; i--) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    const day = dayStem(at.getTime());
    days.push({ day, usd: byDay.get(day) ?? 0 });
  }
  const max = Math.max(0, ...days.map((x) => x.usd));
  return days.map((x) => ({ ...x, share: max > 0 ? x.usd / max : 0 }));
}
