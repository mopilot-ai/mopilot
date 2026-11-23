// A window's split view: the primary pane (the route) and its split panes, which one is focused, the reducer every layout change goes through, and the focused/visible chat selectors.

import type { Route } from './types';
import type { SplitLayout, SplitPane } from '../../shared/model/window';
export type { SplitLayout, SplitPane } from '../../shared/model/window';

/** Split panes beside the primary pane, at most: Claude Desktop's grid holds four panes in a row. */
export const MAX_SPLIT_PANES = 3;

export const NO_SPLIT: SplitLayout = { panes: [], focus: 'primary', primaryWeight: 1 };

/**
 * One layout change. `by` names the agent chat that asked; without it the user did. A user change to a pane makes it
 * the user's (clears `openedBy`), and an agent change to a pane the user owns is refused rather than applied.
 */
export type SplitOp =
  | { op: 'open'; chatId: string; at?: number; by?: string }
  | { op: 'close'; chatId: string; by?: string }
  | { op: 'replace'; chatId: string; next: string }
  | { op: 'move'; chatId: string; to: number }
  | { op: 'swap'; a: string; b: string }
  | { op: 'focus'; target: 'primary' | string }
  | { op: 'resize'; weights: number[] }
  | { op: 'retire'; chatId: string };

/**
 * What an op did. 'visible': the chat is already on screen (a user's open focuses it); 'full': no room for another pane;
 * 'missing': no pane shows the chat; 'not-yours': an agent named a pane it did not open, or one the user has since
 * arranged; 'invalid': the op's arguments don't fit the layout. Only the first eight change the layout.
 */
export type SplitResult =
  | 'opened'
  | 'closed'
  | 'replaced'
  | 'moved'
  | 'swapped'
  | 'focused'
  | 'resized'
  | 'retired'
  | 'visible'
  | 'full'
  | 'missing'
  | 'not-yours'
  | 'invalid';

type ViewState = { route: Route; split?: SplitLayout };

/** The chat the primary pane shows, or null for home and the other pages. */
export const primaryChat = (s: ViewState): string | null => (s.route.name === 'thread' ? s.route.id : null);

/** The focused pane's chat: the window's "current chat" for its title bar, side pane, shortcuts and commands. */
export function focusedChat(s: ViewState): string | null {
  const focus = s.split?.focus ?? 'primary';
  return focus === 'primary' ? primaryChat(s) : focus;
}

/** The focused pane's chat record, if it is a chat this window knows. */
export function focusedThread<T>(s: ViewState & { threads: Record<string, T> }): T | null {
  const id = focusedChat(s);
  return (id && s.threads[id]) || null;
}

/**
 * Whether the pane showing `chatId` (null: home) is the focused one. With no split panes the window has one pane, which
 * is focused whatever chat it is still painting (a switch defers the next chat's view, src/lib/shownThread.ts).
 */
export const isFocusedPane = (s: ViewState, chatId: string | null) => !s.split?.panes.length || focusedChat(s) === chatId;

/** Every chat a pane of this window shows, the primary's first: each one counts as seen. */
export function visibleChats(s: ViewState): string[] {
  const primary = primaryChat(s);
  // a hidden pane's chat is not seen (Settings shows its page alone, src/components/split/SplitFrame.tsx)
  return [...(primary ? [primary] : []), ...(panesShown(s) ? (s.split?.panes ?? []) : []).map((p) => p.chatId)];
}
/** Settings shows its page alone: the split panes wait, hidden, until it is left. */
const panesShown = (s: ViewState) => s.route.name !== 'settings';

/** The focused split pane's chat, or null while the primary pane has the focus. */
export const focusedSplitChat = (s: ViewState): string | null => (s.split?.focus && s.split.focus !== 'primary' ? s.split.focus : null);

/** Whether a split pane (not the primary) shows the chat on screen. */
export const inSplitPane = (s: ViewState, chatId: string) => panesShown(s) && !!s.split?.panes.some((p) => p.chatId === chatId);

/** Which page the primary pane shows and which pane has focus: work that waited checks the view is still this one. */
export const viewToken = (s: ViewState) => ({ route: s.route, focus: s.split?.focus ?? 'primary' });
export const sameView = (a: ReturnType<typeof viewToken>, b: ReturnType<typeof viewToken>) => a.route === b.route && a.focus === b.focus;

/** The layout with the primary pane focused (a navigation of the primary pane focuses it). */
export const focusPrimary = (layout: SplitLayout | undefined): SplitLayout =>
  !layout ? NO_SPLIT : layout.focus === 'primary' ? layout : { ...layout, focus: 'primary' };

/** Agent panes stay only while connected to the primary chat or a user-owned pane, including nested agent opens. */
export function pruneSplitOwners(layout: SplitLayout, primary: string | null): SplitLayout {
  const shown = new Set(primary ? [primary] : []);
  // Resolve by ownership, not column order: an agent's child may sit to the left of its source.
  let added = true;
  while (added) {
    added = false;
    for (const pane of layout.panes) {
      if (!shown.has(pane.chatId) && (!pane.openedBy || shown.has(pane.openedBy))) {
        shown.add(pane.chatId);
        added = true;
      }
    }
  }
  const panes = layout.panes.filter((pane) => shown.has(pane.chatId));
  if (panes.length === layout.panes.length) return layout;
  return { ...layout, panes, focus: shown.has(layout.focus) ? layout.focus : 'primary' };
}

const result = (layout: SplitLayout, r: SplitResult) => ({ layout, result: r });
const indexOf = (layout: SplitLayout, chatId: string) => layout.panes.findIndex((p) => p.chatId === chatId);
const userPane = (p: SplitPane): SplitPane => (p.openedBy ? { chatId: p.chatId, weight: p.weight } : p);
const validWeight = (w: unknown) => typeof w === 'number' && Number.isFinite(w) && w > 0;

/** The layout without the pane at `at`, its focus moved to the primary pane when it had it. */
function without(layout: SplitLayout, at: number): SplitLayout {
  const gone = layout.panes[at].chatId;
  return { ...layout, panes: layout.panes.filter((_, i) => i !== at), focus: layout.focus === gone ? 'primary' : layout.focus };
}

/**
 * Applies one op to the layout as it is now. `primary` is the primary pane's chat, so no chat is shown twice. A result
 * that changes nothing returns the same layout object.
 */
export function applySplit(layout: SplitLayout, primary: string | null, op: SplitOp): { layout: SplitLayout; result: SplitResult } {
  switch (op.op) {
    case 'open': {
      if (!op.chatId) return result(layout, 'invalid');
      const at = indexOf(layout, op.chatId);
      if (at >= 0 || op.chatId === primary) {
        // An explicit user open claims the pane too; ordinary pointer/keyboard focus never changes ownership.
        if (op.by) return result(layout, 'visible');
        const target = at >= 0 ? op.chatId : 'primary';
        const panes = at >= 0 && layout.panes[at].openedBy ? layout.panes.map((p, i) => (i === at ? userPane(p) : p)) : layout.panes;
        return result(layout.focus === target && panes === layout.panes ? layout : { ...layout, panes, focus: target }, 'visible');
      }
      if (layout.panes.length >= MAX_SPLIT_PANES) return result(layout, 'full');
      const pane: SplitPane = op.by ? { chatId: op.chatId, weight: 1, openedBy: op.by } : { chatId: op.chatId, weight: 1 };
      const index = Math.max(0, Math.min(op.at ?? layout.panes.length, layout.panes.length));
      const panes = [...layout.panes.slice(0, index), pane, ...layout.panes.slice(index)];
      // the user's new pane takes the keyboard; an agent's never does
      return result({ ...layout, panes, focus: op.by ? layout.focus : op.chatId }, 'opened');
    }
    case 'close': {
      const at = indexOf(layout, op.chatId);
      if (at < 0) return result(layout, 'missing');
      if (op.by && layout.panes[at].openedBy !== op.by) return result(layout, 'not-yours');
      return result(without(layout, at), 'closed');
    }
    case 'retire': {
      const at = indexOf(layout, op.chatId);
      return at < 0 ? result(layout, 'missing') : result(without(layout, at), 'retired');
    }
    case 'replace': {
      const at = indexOf(layout, op.chatId);
      if (at < 0) return result(layout, 'missing');
      if (!op.next || op.next === op.chatId) return result(layout, 'invalid');
      // the chat it would show is on screen already: focus that pane instead of showing it twice
      if (op.next === primary || indexOf(layout, op.next) >= 0) return result(layout, 'visible');
      const panes = layout.panes.map((p, i) => (i === at ? { chatId: op.next, weight: p.weight } : p));
      return result({ ...layout, panes, focus: layout.focus === op.chatId ? op.next : layout.focus }, 'replaced');
    }
    case 'move': {
      const at = indexOf(layout, op.chatId);
      if (at < 0) return result(layout, 'missing');
      if (!Number.isInteger(op.to) || op.to < 0 || op.to >= layout.panes.length) return result(layout, 'invalid');
      const rest = layout.panes.filter((_, i) => i !== at);
      const panes = [...rest.slice(0, op.to), userPane(layout.panes[at]), ...rest.slice(op.to)];
      return result({ ...layout, panes }, 'moved');
    }
    case 'swap': {
      const a = indexOf(layout, op.a);
      const b = indexOf(layout, op.b);
      if (a < 0 || b < 0) return result(layout, 'missing');
      if (a === b) return result(layout, 'invalid');
      const panes = layout.panes.map((p, i) => (i === a ? userPane(layout.panes[b]) : i === b ? userPane(layout.panes[a]) : p));
      return result({ ...layout, panes }, 'swapped');
    }
    case 'focus': {
      if (op.target !== 'primary' && indexOf(layout, op.target) < 0) return result(layout, 'missing');
      return result(layout.focus === op.target ? layout : { ...layout, focus: op.target }, 'focused');
    }
    case 'resize': {
      const w = op.weights;
      if (!Array.isArray(w) || w.length !== layout.panes.length + 1 || !w.every(validWeight)) return result(layout, 'invalid');
      return result(
        { ...layout, primaryWeight: w[0], panes: layout.panes.map((p, i) => ({ ...userPane(p), weight: w[i + 1] })) },
        'resized',
      );
    }
    default:
      // an op from outside the renderer (an agent tool's request) that names none of the above
      return result(layout, 'invalid');
  }
}
