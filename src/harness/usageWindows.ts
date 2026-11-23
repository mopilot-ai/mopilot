// Quota windows for every harness: their short names, what is left of each, the tightest one, when one
// starts over and whether it still limits, and a Codex account's windows from its last reading. Pure; the meters that draw them are in components/accounts.
import type { AccountLimits } from '../lib/native';
import { USAGE_READ_FRESH_MS } from '../../shared/claudeRateLimit.mjs';
import type { HarnessId, UsageWindow } from './types';

/** A window's short name from its length: 45m, 5h, Weekly, 2d; "Limit" when the length is not known. */
export const windowLabel = (mins: number | null | undefined) =>
  !mins
    ? 'Limit'
    : mins < 60
      ? `${mins}m`
      : mins <= 300
        ? `${Math.round(mins / 60)}h`
        : mins >= 10000
          ? 'Weekly'
          : `${Math.round(mins / 1440)}d`;

/** What a harness calls its all-models weekly window; a harness missing here shows the plain label. */
const WEEKLY_NAME: Partial<Record<HarnessId, string>> = { claude: 'Weekly · All models' };

/** A plan window's name in the composer: "5-hour limit", the harness's own name for its weekly window, "Weekly · Sonnet". */
export function planWindowName(harness: HarnessId, label: string): string {
  if (label === '5h') return '5-hour limit';
  if (label === 'Weekly') return WEEKLY_NAME[harness] ?? label;
  return label.replace(/^Weekly /, 'Weekly · ');
}

/** How long until a unix time: "2d 3h", "4h 10m", "12m". */
export function until(sec: number) {
  const d = Math.max(0, sec - Date.now() / 1000);
  const days = Math.floor(d / 86400);
  const hours = Math.floor((d % 86400) / 3600);
  const mins = Math.floor((d % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
}

/** A reset (unix seconds) still ahead; one not known counts as ahead. */
export const resetAhead = (resetsAt: number | null | undefined) => !resetsAt || resetsAt * 1000 > Date.now();

/** A window that has run out and not started over yet. */
export const windowLimited = (w: { usedPercent: number; resetsAt?: number | null }) => w.usedPercent >= 100 && resetAhead(w.resetsAt);

/**
 * What a window has used now, or null when that is not known: one past its reset started over after the reading, and
 * whatever was used since is not in it, so it is never shown as full (#1582).
 */
export const usedNow = (w: { usedPercent: number; resetsAt?: number | null }): number | null =>
  resetAhead(w.resetsAt) ? w.usedPercent : null;

/** What a window shows where its percent left would be, once its reset passed since it was read. */
export const RESET_SINCE_READ = 'Reset since last read';

/** When a window starts over: "Resets in 2h 5m", "Resets Oct 9 at 12:29am", or null when not known or past. */
export function resetText(w: { resetsAt?: number | null; resetsText?: string | null }): string | null {
  if (!resetAhead(w.resetsAt)) return null;
  return w.resetsAt ? `Resets in ${until(w.resetsAt)}` : w.resetsText ? `Resets ${w.resetsText}` : null;
}

/**
 * When a window starts over, with its clock time: "Resets in 2h 10m · 3:40 PM" within a day, "Resets in 6d 23h · Thu
 * 9:00 AM" beyond (the weekday alone would read as today's right after a weekly reset); the provider's own words when
 * only those are known; null when not known or past.
 */
export function resetWhen(w: { resetsAt?: number | null; resetsText?: string | null }): string | null {
  if (!w.resetsAt) return resetText(w);
  if (!resetAhead(w.resetsAt)) return null;
  const at = new Date(w.resetsAt * 1000);
  const clock =
    w.resetsAt * 1000 - Date.now() < 86_400_000
      ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : at.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `Resets in ${until(w.resetsAt)} · ${clock}`;
}

/** A reading older than this is shown with its age, and no longer prompts a move to paid use. */
export const USAGE_STALE_MS = USAGE_READ_FRESH_MS;

/** Whole percent left of a window, 0 to 100. */
export const percentLeft = (usedPercent: number) => Math.max(0, Math.min(100, 100 - Math.round(usedPercent)));

/** A Codex account's windows from its last reading, in the order Codex reports them (the shorter first). */
export function managedWindows(l: AccountLimits | null | undefined): UsageWindow[] {
  return [l?.primary, l?.secondary].flatMap((w) =>
    w ? [{ label: windowLabel(w.windowDurationMins), usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null }] : [],
  );
}

/** The window closest to running out, or null when there is none. */
export function tightestWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  // a window whose figure is not known is never the tightest
  return windows.reduce<UsageWindow | null>((t, w) => ((usedNow(w) ?? -1) > (t ? (usedNow(t) ?? -1) : -2) ? w : t), null);
}

/** How a window is named after "x% left": "(5h)", "(weekly)"; nothing for a window with no real name. */
export function windowSuffix(w: UsageWindow | null): string {
  if (!w || w.label === 'Usage' || w.label === 'Limit') return '';
  return ` (${w.label.replace(/^Weekly\b/, 'weekly')})`;
}
