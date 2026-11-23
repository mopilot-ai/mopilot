// The grey stamp MoMo's thread draws between days and after a long quiet ("Today 3:17 AM", the design's), from when a turn started and when the one before it did.

/** A gap this long starts a new stamp even within a day. */
export const LONG_GAP_MS = 6 * 60 * 60 * 1000;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * The stamp to draw before a turn that started at `startedSec` (seconds), or null when the turn before it (`previousSec`) is the same day and under LONG_GAP_MS earlier. The first turn always has one.
 */
export function dayStamp(
  startedSec: number | null | undefined,
  previousSec: number | null | undefined,
  nowMs: number,
  locale?: string,
): string | null {
  if (!startedSec) return null;
  const at = new Date(startedSec * 1000);
  const before = previousSec ? new Date(previousSec * 1000) : null;
  if (before && sameDay(before, at) && at.getTime() - before.getTime() < LONG_GAP_MS) return null;
  const now = new Date(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(now.getDate() - 1);
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(at, now)) return `Today ${time}`;
  if (sameDay(at, yesterday)) return `Yesterday ${time}`;
  const year = at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const };
  return `${at.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', ...year })} ${time}`;
}
