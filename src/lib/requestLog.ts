// The request log's wording and matching (Settings → About → Diagnostics → Request log): how a ledger line reads, and
// which lines belong to the failed turn a chat's banner linked from.
import type { LedgerLine } from './native/ledger';
import type { LedgerFocus } from '../../shared/model/window';
import { countsUsage, lineUsd } from '../../shared/costSummary.mjs';
export type { LedgerFocus } from '../../shared/model/window';

/** A turn's time as ms since the epoch: the harnesses report seconds (Codex) or milliseconds. */
export function epochMs(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v;
}

/** A line's error appears a little after the turn's last item, and its first request a little before the turn is marked started. */
const SLACK_BEFORE_MS = 2_000;
const SLACK_AFTER_MS = 10_000;

/** Whether `l` is one of the focused turn's requests: same chat, inside its time (or not ok, when the turn has no time). */
export function inFocus(l: LedgerLine, f: LedgerFocus | null | undefined): boolean {
  if (!f || l.chat !== f.chat) return false;
  const from = epochMs(f.from);
  const to = epochMs(f.to);
  if (from === null && to === null) return l.outcome !== 'ok';
  const t = Date.parse(l.t);
  return (from === null || t >= from - SLACK_BEFORE_MS) && (to === null || t <= to + SLACK_AFTER_MS);
}

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The account as the log names it: its email, else its id; one MoPilot could not confirm says so. */
export function accountText(l: LedgerLine): string {
  const a = l.account;
  if (!a) return '—';
  return `${a.email ?? a.id}${a.verified === false ? ' (unconfirmed)' : ''}`;
}

/** The model asked for and the one that answered, when they differ. */
export function modelText(l: LedgerLine): string {
  if (l.req && l.served && l.req !== l.served) return `${l.req} → ${l.served}`;
  return l.served ?? l.req ?? '—';
}

/** Input, cache and output tokens, leaving out what the harness did not report. */
export function tokensText(l: LedgerLine): string {
  const parts: string[] = [];
  if (typeof l.in === 'number') parts.push(`in ${compact(l.in)}`);
  if (typeof l.cacheRead === 'number' || typeof l.cacheWrite === 'number')
    parts.push(`cache ${compact(l.cacheRead ?? 0)}/${compact(l.cacheWrite ?? 0)}`);
  if (typeof l.out === 'number') parts.push(`out ${compact(l.out)}`);
  if (typeof l.reasoning === 'number' && l.reasoning > 0) parts.push(`think ${compact(l.reasoning)}`);
  return parts.join(' · ') || '—';
}

/** A request's cost at its model's list price (shared/costSummary.mjs lineUsd): a dash for a request with no usage, "No price" for a model without one. */
export function costText(l: LedgerLine): string {
  if (!countsUsage(l)) return '—';
  const usd = lineUsd(l);
  if (usd === null) return 'No price';
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export const OUTCOME_TEXT: Record<LedgerLine['outcome'], string> = {
  ok: 'OK',
  retry: 'Retried',
  error: 'Error',
  interrupted: 'Stopped',
};

/** The outcome with its HTTP status or error kind: "Error 429", "Retried · overloaded". */
export function outcomeText(l: LedgerLine): string {
  const base = OUTCOME_TEXT[l.outcome] ?? l.outcome;
  if (l.status) return `${base} ${l.status}`;
  return l.code && l.outcome !== 'ok' ? `${base} · ${l.code}` : base;
}

/** When a line was written: the time today, the date and time before. */
export function timeText(t: string, now = Date.now()): string {
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

/** The distinct values a field takes in the lines, for a filter's choices. */
export function choices(lines: LedgerLine[], pick: (l: LedgerLine) => string | undefined): string[] {
  return [...new Set(lines.map(pick).filter((v): v is string => !!v))].sort();
}
