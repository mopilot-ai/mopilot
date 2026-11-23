// What the context bar, its legend and the details dialog's grid show for a snapshot: what fills the window in plain names and the palette's order (shared/contextSnapshot.mjs), free space, the compaction reserve at the end with where auto-compact starts, and how far past the window it is.
import {
  plainCategories,
  sinceBreakdown,
  TONES,
  type CategoryTone,
  type ContextCategory,
  type ContextSnapshot,
  type NamedTokens,
} from '../../../shared/contextSnapshot.mjs';

/** A row's color: its group's place in the palette, free space, the reserve, or deferred tools (outside the window). */
export type Series = CategoryTone | 'free' | 'buffer' | 'deferred';
export interface LegendRow {
  id: string;
  label: string;
  tokens: number;
  series: Series;
  /** an estimate (a split of token counts), not the harness's own figure */
  estimated: boolean;
  /** not in the window (deferred tools): its share reads "—" */
  outside: boolean;
  /** the names it was reported as, when it groups or renames them */
  parts: NamedTokens[];
}
export interface ContextMeterModel {
  used: number;
  window: number;
  /** 0–100+, of the window */
  percent: number;
  /** tokens past the window, 0 when it fits */
  over: number;
  /** the bar, in order: content, free space, then the reserve at the end */
  segments: LegendRow[];
  /** the legend: content, the reserve, free space, then what is outside the window */
  legend: LegendRow[];
  /** where auto-compact starts, as a percent of the bar, when it is on and says where */
  mark: number | null;
}

const row = (c: ContextCategory, series: Series): LegendRow => ({
  id: c.id,
  label: c.label,
  tokens: c.tokens,
  series,
  estimated: !!c.estimated,
  outside: c.kind === 'deferred',
  parts: c.parts ?? [],
});
/** content's tone: plainCategories gives every content row one */
const toneOf = (c: ContextCategory) => c.tone as CategoryTone;

/**
 * What a snapshot's window holds, with the tokens reported since its breakdown counted as Conversation (they are the
 * turns since; the bar shimmers until the breakdown is read again), or one Used row when nothing says what fills it.
 */
function contentOf(categories: ContextCategory[], used: number, since: number): ContextCategory[] {
  const content = categories.filter((c) => c.kind === 'used');
  if (since > 0) {
    const at = content.findIndex((c) => c.tone === 'conversation');
    if (at >= 0) content[at] = { ...content[at], tokens: content[at].tokens + since };
    else content.push({ id: 'conversation', label: 'Conversation', tokens: since, kind: 'used', tone: 'conversation' });
  }
  if (!content.length) content.push({ id: 'used', label: 'Used', tokens: used, kind: 'used', tone: 'other' });
  return content.sort((a, b) => TONES.indexOf(toneOf(a)) - TONES.indexOf(toneOf(b)));
}

/** The bar and legend for a snapshot that knows its window, or null when it does not. */
export function contextMeter(s: ContextSnapshot | null): ContextMeterModel | null {
  if (!s || s.used === null || !s.window) return null;
  // a snapshot read back from disk or IPC may lack its rows: it still has its reading
  const categories = plainCategories(Array.isArray(s.categories) ? s.categories : []);
  const content = contentOf(categories, s.used, sinceBreakdown(s)).map((c) => row(c, toneOf(c)));
  const buffer = categories.filter((c) => c.kind === 'buffer').map((c) => row(c, 'buffer'));
  const deferred = categories.filter((c) => c.kind === 'deferred').map((c) => row(c, 'deferred'));
  const filled = [...content, ...buffer].reduce((n, r) => n + r.tokens, 0);
  const left = s.window - filled;
  const free: LegendRow[] =
    left > 0 ? [{ id: 'free', label: 'Free space', tokens: left, series: 'free', estimated: false, outside: false, parts: [] }] : [];
  const at = s.autoCompact?.enabled ? s.autoCompact.threshold : null;
  return {
    used: s.used,
    window: s.window,
    percent: (s.used / s.window) * 100,
    over: Math.max(0, s.used - s.window),
    segments: [...content, ...free, ...buffer],
    legend: [...content, ...buffer, ...free, ...deferred],
    // the bar spans the window, or more when the reserve takes it past its end
    mark: at ? Math.min(100, (at / Math.max(s.window, filled)) * 100) : null,
  };
}

/** "12.3%" of the window, or "—" for what is outside it. */
export const shareOf = (r: Pick<LegendRow, 'tokens' | 'outside'>, window: number) =>
  r.outside ? '—' : `${((r.tokens / window) * 100).toFixed(1)}%`;

/**
 * The dialog's grid: `count` cells across the bar's segments in order, each the series its middle falls in. A window
 * filled past its end spreads the cells over everything in it.
 */
export function cellsOf(m: ContextMeterModel, count = 100): Series[] {
  const total = Math.max(
    m.window,
    m.segments.reduce((n, x) => n + x.tokens, 0),
  );
  const ends: number[] = [];
  let sum = 0;
  for (const x of m.segments) ends.push((sum += x.tokens));
  // the last segment ends at the total, so every cell's middle falls in one
  return Array.from({ length: count }, (_, cell) => m.segments[ends.findIndex((end) => ((cell + 0.5) / count) * total < end)].series);
}
