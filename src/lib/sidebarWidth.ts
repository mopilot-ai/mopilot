// Clamping a column's saved width to what the window can show.
import { SIDEBAR_BOUNDS, sidebarMaxWidth, type SizeBounds } from './sidebarSizing';

/**
 * Persisted widths and drag coordinates must never collapse an open column to a sliver, nor squeeze the chat (and the
 * panel `beside` it) below its minimum: the saved width is clamped on load and whenever the window or a panel changes.
 * `bounds` and `fallback` are the sidebar's unless MoMo's rail or pane give theirs.
 */
export function sidebarWidth(value: unknown, viewport = Infinity, beside = 0, bounds: SizeBounds = SIDEBAR_BOUNDS, fallback = 288): number {
  const width = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(bounds.min, Math.min(sidebarMaxWidth(viewport, beside, bounds), width));
}
