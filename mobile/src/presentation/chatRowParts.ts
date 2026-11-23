// The small parts of a chat row: how old the chat is and what its line of changes says.
const MINUTE = 60_000;

/** "now", "5m", "3h", "2d", "1w", "2mo", "1y": the age of a chat at `now` in the words the Mac's sidebar uses (`relativeTime`), or nothing where the computer sent no time (or a time ahead of this clock reads as now). */
export function ageLabel(at: unknown, now: number): string | null {
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const minutes = Math.floor((now - at) / MINUTE);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return days < 365 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days / 365)}y`;
}

export type Changes = { added: number; removed: number };

/** The lines a chat's folder changed, when the computer sent them as two whole numbers; anything else, or nothing changed, is no line at all. */
export function changesOf(v: unknown): Changes | null {
  const c = v as { added?: unknown; removed?: unknown } | null | undefined;
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  return c && whole(c.added) && whole(c.removed) && c.added + c.removed > 0 ? { added: c.added, removed: c.removed } : null;
}
