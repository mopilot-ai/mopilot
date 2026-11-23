// Split view's drop zones, as Claude Desktop's Code tab draws them: a chat dragged from the sidebar onto a pane's edge
// opens in a new pane there ("Split view"), onto its middle replaces what the pane shows ("Open here"); a split pane
// dragged by its header onto another pane's edge moves there ("Move here"), onto its middle swaps the two ("Swap").

/** The sidebar's chat rows put their chat id under this type (src/components/sidebar/ThreadRow.tsx DraggableChat). */
export const CHAT_DRAG = 'text/x-codex-thread';
/** A split pane's header puts its chat id under this type. */
export const PANE_DRAG = 'application/x-mopilot-split-pane';

export const DROP_LABEL = { split: 'Split view', here: 'Open here', swap: 'Swap', move: 'Move here' } as const;

/** A pane as laid out: 'primary' or a split pane's chat, and its box. */
export interface PaneBox {
  target: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * What a drop does:
 * - split: a new pane at split-pane index `at`;
 * - here: the pane `target` shows the dragged chat (the primary pane navigates);
 * - swap: the dragged pane and `target` trade places;
 * - move: the dragged pane goes to split-pane index `to`.
 */
export type DropAction =
  | { kind: 'split'; at: number }
  | { kind: 'here'; target: string }
  | { kind: 'swap'; target: string }
  | { kind: 'move'; to: number };

export type DropZone = { action: DropAction; label: string; box: Omit<PaneBox, 'target'> };

/** What is being dragged: a chat from the sidebar, or a split pane by its header. */
export type Dragged = { kind: 'chat' } | { kind: 'pane'; chatId: string };

/** The share of a pane's width (at most this many px) that is its edge, where a drop makes or moves a column. */
const EDGE_SHARE = 0.25;
const EDGE_MAX = 120;

/**
 * The zone under the pointer at (`x`, `y`) over `panes` (the primary pane first, then each split pane, left to right),
 * or null where a drop would do nothing (outside every pane, a pane onto itself, a split pane onto the primary pane's
 * middle). A split pane can't go left of the primary pane, so the primary pane's left edge is its middle.
 */
export function dropZone(panes: PaneBox[], x: number, y: number, dragged: Dragged): DropZone | null {
  const i = panes.findIndex((p) => x >= p.left && x <= p.right && y >= p.top && y <= p.bottom);
  if (i < 0) return null;
  const pane = panes[i];
  const edge = Math.min((pane.right - pane.left) * EDGE_SHARE, EDGE_MAX);
  const strip = (left: number) => ({ left, right: left + edge, top: pane.top, bottom: pane.bottom });
  const side = x > pane.right - edge ? 'right' : i > 0 && x < pane.left + edge ? 'left' : 'middle';
  // the split-pane index a new or moved pane lands at: after this pane (right edge) or before it (left edge)
  const at = side === 'right' ? i : i - 1;
  const whole = { left: pane.left, right: pane.right, top: pane.top, bottom: pane.bottom };
  const box = side === 'right' ? strip(pane.right - edge) : side === 'left' ? strip(pane.left) : whole;
  if (dragged.kind === 'chat') {
    if (side !== 'middle') return { action: { kind: 'split', at }, label: DROP_LABEL.split, box };
    return { action: { kind: 'here', target: pane.target }, label: DROP_LABEL.here, box };
  }
  const from = panes.findIndex((p) => p.target === dragged.chatId) - 1;
  if (from < 0) return null;
  if (side === 'middle') {
    if (i === 0 || i - 1 === from) return null;
    return { action: { kind: 'swap', target: pane.target }, label: DROP_LABEL.swap, box };
  }
  // the index it takes once lifted out of its place; its own place is no move
  const to = at > from ? at - 1 : at;
  if (to === from) return null;
  return { action: { kind: 'move', to }, label: DROP_LABEL.move, box };
}
