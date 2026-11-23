// The widths of MoMo's rail and side pane, kept as the app sidebar keeps its own (App.tsx): the saved width is clamped to the window and to what the chat and the other column need (src/lib/sidebarWidth.ts, limits in src/lib/sidebarSizing.ts), a drag sets a live width that is saved only when it ends (SidebarResize), and the saved one is read again when the window changes.
import { useLayoutEffect, useState } from 'react';
import { PANE_BOUNDS, RAIL_BOUNDS, type SizeBounds } from '../../../lib/sidebarSizing';
import { sidebarWidth } from '../../../lib/sidebarWidth';
import { useViewportWidth } from '../../../lib/useViewportWidth';
import { setPrefs, useStore } from '../../../store/core';

/** The rail's width before anyone resized it (the design's), and the pane's. */
export const RAIL_DEFAULT_WIDTH = 288;
export const PANE_DEFAULT_WIDTH = 420;

type WidthKey = 'momoRailWidth' | 'momoPaneWidth';

/** One column's width: `beside` is what shares the lane with the chat. */
function useColumnWidth(saved: number | undefined, key: WidthKey, bounds: SizeBounds, fallback: number, beside: number) {
  const viewport = useViewportWidth();
  const [width, setWidth] = useState(() => sidebarWidth(saved, viewport, beside, bounds, fallback));
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    if (!dragging) setWidth(sidebarWidth(saved, viewport, beside, bounds, fallback));
  }, [saved, dragging, viewport, beside, bounds, fallback]);
  return { width, setWidth, dragging, setDragging, bounds, save: (value: number) => setPrefs({ [key]: value }) };
}

export const useRailWidth = (beside: number) =>
  useColumnWidth(
    useStore((s) => s.prefs.momoRailWidth),
    'momoRailWidth',
    RAIL_BOUNDS,
    RAIL_DEFAULT_WIDTH,
    beside,
  );
export const usePaneWidth = (beside: number) =>
  useColumnWidth(
    useStore((s) => s.prefs.momoPaneWidth),
    'momoPaneWidth',
    PANE_BOUNDS,
    PANE_DEFAULT_WIDTH,
    beside,
  );
