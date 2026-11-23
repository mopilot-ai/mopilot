// The sidebar's resize handle: pointer and keyboard resizing, kept on the frame so collapsing doesn't cancel it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { frameCoalescer } from '../../lib/edgeDrag';
import {
  SIDEBAR_BOUNDS,
  finishSidebarResize,
  sidebarDragWidth,
  sidebarKeyWidth,
  sidebarMaxWidth,
  type SizeBounds,
} from '../../lib/sidebarSizing';

/** Lives on the frame rather than inside the sidebar, so its pointer capture survives collapse. */
export function SidebarResize({
  open,
  width,
  dragging,
  onWidthChange,
  onOpenChange,
  onSaveWidth,
  onDraggingChange,
  beside = 0,
  name = 'sidebar',
  bounds = SIDEBAR_BOUNDS,
  edge = 'left',
  shortcut,
}: {
  open: boolean;
  width: number;
  dragging: boolean;
  onWidthChange: (width: number) => void;
  onOpenChange: (open: boolean) => void;
  onSaveWidth: (width: number) => void;
  onDraggingChange: (dragging: boolean) => void;
  /** the width a panel beside the chat needs (a side pane's minimum, the summary island): the sidebar leaves it room */
  beside?: number;
  /** what the handle resizes, in its accessible name: MoMo's rail is not "the sidebar" */
  name?: string;
  /** the column's limits and key steps: the sidebar's unless given (MoMo's rail and pane) */
  bounds?: SizeBounds;
  /** which side of the window the column is on: a pane on the `right` grows as its handle is dragged left */
  edge?: 'left' | 'right';
  /** the key that toggles the column, for assistive technology (aria-keyshortcuts) */
  shortcut?: string;
}) {
  const press = useRef<{ pointerId: number; x: number; width: number; current: number } | null>(null);
  // a move sets the width once per frame, not once per pointer event: each one renders the whole window (#2049)
  const widthChange = useRef(onWidthChange);
  useLayoutEffect(() => {
    widthChange.current = onWidthChange;
  }, [onWidthChange]);
  const [frames] = useState(() => frameCoalescer((next: number) => widthChange.current(next)));
  useEffect(() => frames.cancel, [frames]);
  const visibleWidth = open || dragging ? width : 0;
  const commit = (next: number) =>
    finishSidebarResize(
      next,
      onWidthChange,
      () => onOpenChange(false),
      (expanded) => {
        onSaveWidth(expanded);
        onOpenChange(true);
      },
      bounds,
    );
  const finish = (pointerId: number, cancelled = false) => {
    const current = press.current;
    if (!current || current.pointerId !== pointerId) return;
    press.current = null;
    frames.cancel();
    if (cancelled) onWidthChange(current.width);
    else commit(current.current);
    onDraggingChange(false);
  };

  return (
    <div
      className={`sidebar-resize ${dragging ? 'resizing' : ''} ${visibleWidth === 0 ? 'collapsed' : ''} ${edge === 'right' ? 'edge-right' : ''}`}
      style={edge === 'left' ? { left: visibleWidth } : { right: visibleWidth }}
      role="separator"
      aria-label={open ? `Resize ${name}` : `Drag to open ${name}`}
      aria-orientation="vertical"
      aria-valuenow={Math.round(visibleWidth)}
      aria-valuemin={bounds.homeHides ? 0 : bounds.min}
      aria-valuemax={sidebarMaxWidth(window.innerWidth, beside, bounds)}
      aria-keyshortcuts={shortcut}
      aria-valuetext={
        visibleWidth === 0
          ? `${name[0].toUpperCase()}${name.slice(1)} hidden; drag right to open`
          : visibleWidth < bounds.collapse
            ? `Release to hide ${name}`
            : `${Math.round(visibleWidth)} pixels`
      }
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        press.current = { pointerId: event.pointerId, x: event.clientX, width: visibleWidth, current: visibleWidth };
        onWidthChange(visibleWidth);
        onDraggingChange(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = press.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const next = sidebarDragWidth(
          current.width,
          (edge === 'left' ? 1 : -1) * (event.clientX - current.x),
          window.innerWidth,
          beside,
          bounds,
        );
        current.current = next;
        frames.push(next);
      }}
      onPointerUp={(event) => {
        finish(event.pointerId);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => finish(event.pointerId, true)}
      onLostPointerCapture={(event) => finish(event.pointerId)}
      onKeyDown={(event) => {
        const next = sidebarKeyWidth(
          event.key,
          visibleWidth,
          window.innerWidth,
          beside,
          bounds,
          event.shiftKey,
          edge === 'left' ? 'ArrowRight' : 'ArrowLeft',
        );
        if (next === null) return;
        event.preventDefault();
        commit(next);
      }}
    />
  );
}
