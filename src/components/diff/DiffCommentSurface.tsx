// A selection-adjacent comment button shared by unified and split diffs, scoped to one chat/file revision and column.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from '../ui/icons';
import type { DiffCell, DiffCommentPicker } from './DiffComments';
import { imeComposing } from '../../lib/focus';

type Columns = (DiffCell | undefined)[][];
interface SelectionPosition {
  col: number;
  anchor: number;
  head: number;
  left: number;
  top: number;
}

function endpoint(node: Node, columns: Columns) {
  const element = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-diff-row]');
  if (!element) return null;
  const col = Number(element.dataset.diffCol);
  const row = Number(element.dataset.diffRow);
  return columns[col]?.[row] ? { element, col, row } : null;
}

/** Ownership is independent of visibility: off-screen selections must still retire with their chat/file. */
function ownedRange(container: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return container.contains(range.startContainer) && container.contains(range.endContainer) ? range : null;
}

/** Native text selections may cross tokens and rows, but must stay inside one diff's code column. */
export function readDiffSelection(container: HTMLElement, columns: Columns): SelectionPosition | null {
  const range = ownedRange(container);
  if (!range || !range.toString().trim()) return null;
  const start = endpoint(range.startContainer, columns);
  const end = endpoint(range.endContainer, columns);
  if (!start || !end || start.col !== end.col) return null;
  // Ending at the start of the next row does not select that row (and vice versa at the first row's end).
  const edge = range.cloneRange();
  edge.selectNodeContents(end.element);
  edge.setEnd(range.endContainer, range.endOffset);
  const head = end.row - (end.row > start.row && !edge.toString().length ? 1 : 0);
  edge.selectNodeContents(start.element);
  edge.setStart(range.startContainer, range.startOffset);
  const anchor = start.row + (head > start.row && !edge.toString().length ? 1 : 0);
  const bounds = container.getBoundingClientRect();
  const viewport = (container.closest('.cp-diffs') ?? container).getBoundingClientRect();
  const header = container.closest('.cp-file')?.querySelector('.cp-file-head')?.getBoundingClientRect();
  const column = start.element.closest('.split-row') ? start.element.closest('.idiff-row')!.getBoundingClientRect() : null;
  const left = Math.max(bounds.left, viewport.left, column?.left ?? 0, 0);
  const right = Math.min(bounds.right, viewport.right, column?.right ?? window.innerWidth, window.innerWidth);
  const top = Math.max(bounds.top, viewport.top, header?.bottom ?? 0, 0);
  const bottom = Math.min(bounds.bottom, viewport.bottom, window.innerHeight);
  for (const rect of Array.from(range.getClientRects()).reverse()) {
    if (rect.right <= left || rect.left >= right || rect.bottom <= top || rect.top >= bottom || !rect.width || !rect.height) continue;
    return {
      col: start.col,
      anchor,
      head,
      left: Math.max(left + 4, Math.min(rect.right + 6, right - 28)),
      top: Math.max(top, Math.min(rect.top - 2, bottom - 24)),
    };
  }
  return null;
}

export function DiffCommentSurface({
  children,
  columns,
  picker,
  identity,
  enabled,
  maxHeight,
}: {
  children: ReactNode;
  columns: Columns;
  picker: DiffCommentPicker;
  identity: string;
  enabled: boolean;
  maxHeight?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const previousIdentity = useRef(identity);
  const pressing = useRef(false);
  const [selected, setSelected] = useState<(SelectionPosition & { identity: string }) | null>(null);
  // read at each event rather than subscribed to: a caller's new columns array on every render must not tear the
  // listeners down and read the selection again, which on a diff of many files cost a drag a second per move (#2049)
  const latestColumns = useRef(columns);
  useLayoutEffect(() => {
    latestColumns.current = columns;
  }, [columns]);
  useEffect(() => {
    const root = container.current!;
    if (previousIdentity.current !== identity) {
      previousIdentity.current = identity;
      pressing.current = false;
      if (ownedRange(root)) window.getSelection()!.removeAllRanges();
      setSelected(null);
    }
    if (!enabled) return;
    const update = () => {
      const next = pressing.current ? null : readDiffSelection(root, latestColumns.current);
      const value = next && { ...next, identity };
      setSelected((previous) => (JSON.stringify(previous) === JSON.stringify(value) ? previous : value));
    };
    const down = () => {
      pressing.current = true;
      setSelected(null);
    };
    const up = () => {
      pressing.current = false;
      update();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !imeComposing(event) && ownedRange(root)) {
        window.getSelection()!.removeAllRanges();
        setSelected(null);
      }
    };
    const resize = new ResizeObserver(update);
    resize.observe(root);
    document.addEventListener('selectionchange', update);
    root.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.addEventListener('keydown', key);
    update();
    return () => {
      resize.disconnect();
      document.removeEventListener('selectionchange', update);
      root.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('keydown', key);
    };
  }, [identity, enabled]);
  return (
    <>
      <div ref={container} className="idiff-body" style={{ maxHeight }}>
        {children}
      </div>
      {enabled &&
        selected?.identity === identity &&
        !picker.picking?.open &&
        createPortal(
          <button
            type="button"
            className="diff-comment-add diff-selection-add"
            aria-label="Comment on selected lines"
            title="Comment on selected lines"
            style={{ left: selected.left, top: selected.top }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const current = readDiffSelection(container.current!, columns);
              if (current) {
                picker.openRange(current.col, current.anchor, current.head);
                window.getSelection()!.removeAllRanges();
              }
              setSelected(null);
            }}
          >
            <Plus size={14} strokeWidth={2.2} />
          </button>,
          document.body,
        )}
    </>
  );
}
