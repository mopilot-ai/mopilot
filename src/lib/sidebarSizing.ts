// The width limits, drag and keyboard resizing, and collapsing of a resizable column: the app's sidebar, and by the same functions with other bounds MoMo's rail and side pane (#4926).

import { CHAT_MIN_WIDTH, SHELL_WIDTH, clampSplit } from './splitClamp';

/** What a resizable column is allowed: its widths, when a drag hides it, and what each key does. */
export interface SizeBounds {
  min: number;
  max: number;
  /** a drag released below this hides the column */
  collapse: number;
  /** a drag under this snaps to zero */
  snap: number;
  /** ArrowLeft/ArrowRight move this far, Shift+arrow `shiftStep` */
  step: number;
  shiftStep: number;
  /** Home hides the column (and ArrowLeft at the minimum does too) instead of going to the minimum */
  homeHides: boolean;
}

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_COLLAPSE_WIDTH = SIDEBAR_MIN_WIDTH / 2;
export const SIDEBAR_SNAP_WIDTH = 48;

export const SIDEBAR_MAX_WIDTH = 560;

/** The app's sidebar. */
export const SIDEBAR_BOUNDS: SizeBounds = {
  min: SIDEBAR_MIN_WIDTH,
  max: SIDEBAR_MAX_WIDTH,
  collapse: SIDEBAR_COLLAPSE_WIDTH,
  snap: SIDEBAR_SNAP_WIDTH,
  step: 10,
  shiftStep: 10,
  homeHides: true,
};

/** MoMo's rail: 232 to 420, 8 px keys and 32 px with Shift, Home and End go to the limits. */
export const RAIL_BOUNDS: SizeBounds = { min: 232, max: 420, collapse: 116, snap: 48, step: 8, shiftStep: 32, homeHides: false };

/** MoMo's side pane: opens at 420, never narrower, 732 at most; dragged left it grows. */
export const PANE_BOUNDS: SizeBounds = { min: 420, max: 732, collapse: 210, snap: 48, step: 8, shiftStep: 32, homeHides: false };

/**
 * The widest the column may be in this window: whatever leaves the chat its minimum and the panel beside it
 * (`beside`: a side pane's minimum or the summary island) its width (src/lib/splitClamp.ts), but never under the
 * column's own minimum (narrower windows collapse it instead).
 */
export const sidebarMaxWidth = (viewport: number, beside = 0, bounds: SizeBounds = SIDEBAR_BOUNDS) =>
  Math.max(
    bounds.min,
    clampSplit(bounds.max, viewport - SHELL_WIDTH, {
      min: bounds.min,
      keep: CHAT_MIN_WIDTH + beside,
      max: bounds.max,
    }),
  );

export function sidebarDragWidth(startWidth: number, delta: number, viewport: number, beside = 0, bounds: SizeBounds = SIDEBAR_BOUNDS) {
  const width = Math.max(0, Math.min(sidebarMaxWidth(viewport, beside, bounds), startWidth + delta));
  return width < bounds.snap ? 0 : width;
}

/** Closing retains the saved expanded width; an intermediate drag width is never persisted. */
export function finishSidebarResize(
  width: number,
  resize: (width: number) => void,
  close: () => void,
  save: (width: number) => void,
  bounds: SizeBounds = SIDEBAR_BOUNDS,
) {
  if (width < bounds.collapse) {
    resize(0);
    close();
  } else {
    const expanded = Math.max(bounds.min, width);
    resize(expanded);
    save(expanded);
  }
}

/**
 * The width a key on the focused separator asks for, or null for a key it does not own. `grow` is the arrow that widens
 * the column (ArrowRight for a column on the left, ArrowLeft for a pane on the right).
 */
export function sidebarKeyWidth(
  key: string,
  width: number,
  viewport: number,
  beside = 0,
  bounds: SizeBounds = SIDEBAR_BOUNDS,
  shift = false,
  grow = 'ArrowRight',
): number | null {
  const max = sidebarMaxWidth(viewport, beside, bounds);
  const shrink = grow === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return null;
  if (bounds.homeHides) {
    if (key === 'Home' || (key === shrink && width <= bounds.min)) return 0;
    if (key === grow && width === 0) return bounds.min;
  } else if (key === 'Home') return bounds.min;
  if (key === 'End') return max;
  const step = shift ? bounds.shiftStep : bounds.step;
  return Math.max(bounds.min, Math.min(max, width + (key === grow ? step : -step)));
}
