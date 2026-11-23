// What a Claude Code rate_limit_event says about the login's plan usage, in the usage model every account surface reads
// (windows by label, used %, reset time): one reading main keeps for the login that served the turn and the windows merge.

import { resetTime } from './claudeResetTime.mjs';

/** The CLI's window names, as /usage's text names the same windows (src/harness/claudeUsage.ts parseUsageText). */
const LABEL = {
  five_hour: '5h',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
};
const labelOf = (kind) => (Object.hasOwn(LABEL, kind) ? LABEL[kind] : kind);
/** Extra usage (overage) is billed beside the plan, not a plan window: `seven_day_overage_included` is no limit to show. */
const isOverage = (kind) => /overage/i.test(kind);
const seconds = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The plan windows a rate_limit_info lists (`unifiedWindows`), by the CLI's name for each; extra usage is left out.
 * @param {any} info
 * @returns {[string, any][]}
 */
export function planWindowEntries(info) {
  const uw = info?.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  return Object.entries(uw).filter(([k, v]) => !isOverage(k) && v && typeof v.utilization === 'number');
}

/**
 * The most used plan window of a rate_limit_info, as a fraction (0 when it reports none): the windows it lists, and
 * the one window an older CLI names (`rateLimitType`, `utilization`); extra usage counts toward neither.
 * @param {any} info
 */
export function planUtilization(info) {
  const kind = typeof info?.rateLimitType === 'string' ? info.rateLimitType : null;
  const older = typeof info?.utilization === 'number' && !(kind && isOverage(kind)) ? info.utilization : 0;
  return Math.max(0, older, ...planWindowEntries(info).map(([, w]) => w.utilization));
}

/**
 * The usage a rate_limit_info reports, measured at `at` (ms). Newer CLIs send every window (`unifiedWindows`), older
 * ones the one in question (`rateLimitType`, `utilization`). A refusal (`status: 'rejected'`) is that window used up
 * until its reset, whatever fraction came with it.
 * @param {any} info
 * @param {number} at
 */
export function claudeLiveUsage(info, at) {
  /** @type {{ label: string, usedPercent: number, resetsAt: number | null }[]} */
  const windows = [];
  for (const [k, v] of planWindowEntries(info))
    windows.push({ label: labelOf(k), usedPercent: Math.round(v.utilization * 100), resetsAt: seconds(v.resetsAt) });
  const kind = typeof info?.rateLimitType === 'string' ? info.rateLimitType : null;
  if (!windows.length && !(kind && isOverage(kind)) && typeof info?.utilization === 'number')
    windows.push({
      label: kind ? labelOf(kind) : 'Limit',
      usedPercent: Math.round(info.utilization * 100),
      resetsAt: seconds(info.resetsAt),
    });
  if (info?.status === 'rejected' && kind) {
    const label = labelOf(kind);
    const w = windows.find((x) => x.label === label);
    const full = { label, usedPercent: 100, resetsAt: seconds(info.resetsAt) ?? w?.resetsAt ?? null };
    if (w) Object.assign(w, full);
    // a plan window the event did not list; extra usage running out ('overage') is no plan window to show
    else if (Object.hasOwn(LABEL, kind)) windows.push(full);
  }
  return { windows, status: typeof info?.status === 'string' ? info.status : null, at };
}

/**
 * When a refused login can be used again (ms), from the windows that are used up and the refusal's own reset; null
 * when the event is no refusal, or names no reset.
 * @param {any} info
 */
export function claudeLimitResetsAt(info) {
  if (info?.status !== 'rejected') return null;
  const full = claudeLiveUsage(info, 0).windows.filter((w) => w.usedPercent >= 100);
  const resets = [...full.map((w) => w.resetsAt), seconds(info.resetsAt)].filter((s) => s != null);
  return resets.length ? Math.max(...resets) * 1000 : null;
}

/** A /usage read measured longer ago than this is a cached answer: it says what was left, not what is left. One age for main's hold and the window's offer. */
export const USAGE_READ_FRESH_MS = 10 * 60_000;

/**
 * The plan windows the CLI's /usage text prints ("Current week (all models): 100% used · resets Nov 1 at 10am (zone)"):
 * each window's used percent and its text. Extra usage is no plan window; it is not listed.
 * @param {string} text
 * @returns {{ used: number, block: string }[]}
 */
function usageTextWindows(text) {
  const clean = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const headings = [...clean.matchAll(/^\s*Current[ \t]+(?:session|week)\b/gim)];
  return headings.flatMap((m, i) => {
    const block = clean.slice(m.index + m[0].length, headings[i + 1]?.index ?? clean.length).split(/^[ \t]*Extra usage\b/im)[0];
    const used = Number(block.match(/(?<![-.\d])(\d+(?:\.\d+)?)\s*%[ \t]*used/i)?.[1]);
    return Number.isFinite(used) && used <= 100 ? [{ used, block }] : [];
  });
}

/**
 * What is left (percent) of the most used plan window in the CLI's /usage text ("Current session: 8% used"), null when
 * it prints none. Extra usage is no plan window; it is not counted.
 * @param {string} text
 */
export function usageTextLeft(text) {
  const windows = usageTextWindows(text);
  return windows.length ? Math.max(0, 100 - Math.round(Math.max(...windows.map((w) => w.used)))) : null;
}

/**
 * What the /usage text says of the plan: what is left (usageTextLeft) and, when a window is used up and prints when it
 * starts over, the latest such reset (ms; null when none prints one), read in the zone the text names. null when it
 * prints no window. `printedAt` (ms) dates a reset that names no year.
 * @param {string} text
 * @param {number} printedAt
 * @returns {{ left: number, resetsAt: number | null } | null}
 */
export function usageTextLimit(text, printedAt) {
  const left = usageTextLeft(text);
  if (left === null) return null;
  const resets = usageTextWindows(text)
    .filter((w) => w.used >= 100)
    .map((w) => w.block.match(/resets[ \t]+(.+?)(?:[ \t]*\(([^)]+)\))?[ \t]*$/im))
    .flatMap((m) => (m ? [resetTime(m[1], m[2], printedAt)] : []))
    .flatMap((t) => (t === null ? [] : [t * 1000]));
  return { left, resetsAt: resets.length ? Math.max(...resets) : null };
}
