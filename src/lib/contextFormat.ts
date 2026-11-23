// How every context display writes its numbers (the composer ring, the context panel and dialog, the summary card, Status): token counts as 840, 9.5k, 83.4k, 200k, 1.2M, and the share of the window as 42%, <1% or 100%+.

/**
 * A token count: whole below a thousand, else thousands or millions to one decimal with a trailing .0 dropped. The unit
 * is picked after rounding, so 999,950 reads 1M, never 1000k.
 */
export function contextTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  const k = Number((v / 1000).toFixed(1));
  return k < 1000 ? `${k}k` : `${Number((v / 1_000_000).toFixed(1))}M`;
}

/** The share of a window in use, rounded: "<1%" for a sliver (never a 0% that hides use), "100%+" past the window. */
export function contextShare(used: number, window: number): string {
  if (used > window) return '100%+';
  const pct = (used / window) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

/** How a share of the window reads: quiet while there is room, amber from 80%, red from 95%. */
export const contextLevel = (pct: number) => (pct >= 95 ? 'full' : pct >= 80 ? 'warn' : 'ok');
