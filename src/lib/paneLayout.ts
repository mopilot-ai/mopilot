// Side pane layout rules: which tabs open full width, a new pane's starting width and the width the user last chose.

import type { PaneTab } from '../../shared/model/window';
import { CHAT_MIN_WIDTH, PANE_MIN_WIDTH, SUMMARY_SLOT_WIDTH, clampSplit } from './splitClamp';

/** Conversation-related tabs and terminals keep the main chat visible, even after a full-view tab. */
export function paneOpensFull(kind: PaneTab['kind'], open: boolean, full: boolean, defaultFull: boolean) {
  if (['browser', 'artifact', 'chat', 'skill', 'file', 'plan', 'outputs', 'usage', 'terminal'].includes(kind)) return false;
  return open ? full : defaultFull;
}

/** The pane's limits inside its lane: the chat keeps its minimum, the pane keeps its own (src/lib/splitClamp.ts). */
const PANE_SPLIT = { min: PANE_MIN_WIDTH, keep: CHAT_MIN_WIDTH };

/** Measure the content lane, excluding the sidebar, so a new pane takes its right half (at most 860px). */
export function initialPaneWidth(availableWidth: number) {
  return clampSplit(Math.min(860, availableWidth / 2), availableWidth, PANE_SPLIT);
}

/** Which remembered width a pane opens at: side chats, tasks, terminals and skills sit narrower beside the chat. */
export type PaneWidthGroup = 'wide' | 'narrow';
export const paneWidthGroup = (kind: PaneTab['kind'] | undefined): PaneWidthGroup =>
  kind === 'chat' || kind === 'tasks' || kind === 'terminal' || kind === 'skill' ? 'narrow' : 'wide';

/** The share of the lane the user last dragged each group's pane to (prefs.paneWidths), as saved: anything else is ignored. */
export type PaneWidths = Partial<Record<PaneWidthGroup, number>>;
const share = (v: unknown): number | null => (typeof v === 'number' && v > 0 && v < 1 ? v : null);

/** A pane opening in `lane`: at the share the user last chose for its group, kept within the limits, else the default. */
export function openingPaneWidth(lane: number, widths: unknown, group: PaneWidthGroup) {
  const saved = widths && typeof widths === 'object' ? share((widths as Record<string, unknown>)[group]) : null;
  return saved === null ? initialPaneWidth(lane) : clampSplit(saved * lane, lane, PANE_SPLIT);
}

/** prefs.paneWidths with `group` set to the share `width` takes of `lane`, or forgotten (null width, or no lane). */
export function rememberPaneWidth(widths: unknown, group: PaneWidthGroup, width: number | null, lane: number): PaneWidths {
  const kept: PaneWidths = {};
  if (widths && typeof widths === 'object')
    for (const g of ['wide', 'narrow'] as const) {
      const v = share((widths as Record<string, unknown>)[g]);
      if (v !== null && g !== group) kept[g] = v;
    }
  const next = width !== null && lane > 0 ? share(Math.round((width / lane) * 1000) / 1000) : null;
  return next === null ? kept : { ...kept, [group]: next };
}

/**
 * A pane's width once its lane changed (the window or the sidebar moved after it opened): the chat keeps its
 * minimum and the pane its own; a lane too small for both splits in proportion. An unmeasured lane changes nothing.
 */
export function fitPaneWidth(width: number, lane: number) {
  return clampSplit(width, lane, PANE_SPLIT);
}

/** The width of the lane the pane shares with the chat (its parent), or the window's when it has none. */
export const paneLane = (pane: HTMLElement) => pane.parentElement?.clientWidth || window.innerWidth;

/** Dragging the pane's edge: the same limits, so the divider can never push the chat below its minimum. */
export function dragPaneWidth(startWidth: number, delta: number, lane: number) {
  return clampSplit(startWidth + delta, lane, PANE_SPLIT);
}

/**
 * The room the panel beside the chat needs, for the sidebar to leave: a side pane's minimum while it shares the
 * lane (on a chat or home, not in full view), else the summary island on a chat (SummarySlot shows it then), else 0.
 */
export function besideWidth(route: string, paneOpen: boolean, paneFull: boolean, summaryOpen: boolean) {
  if (paneOpen && (route === 'thread' || route === 'home')) return paneFull ? 0 : PANE_MIN_WIDTH;
  return summaryOpen && !paneOpen && route === 'thread' ? SUMMARY_SLOT_WIDTH : 0;
}
