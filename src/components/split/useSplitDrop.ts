// Dragging onto split view: a sidebar chat or a split pane's header over the main area shows the zone a drop would use
// (src/lib/splitDrop.ts), and the drop applies it to the layout as it is then.

import { useState, type DragEvent, type RefObject } from 'react';
import { applySplitOp, openInSplit } from '../../store/splitView';
import { navigate } from '../../store/panes';
import { CHAT_DRAG, PANE_DRAG, dropZone, type DropAction, type DropZone, type PaneBox } from '../../lib/splitDrop';

/** The split pane whose header is being dragged: a drag's data can't be read until the drop. */
let draggedPane: string | null = null;
export const setDraggedPane = (chatId: string | null) => {
  draggedPane = chatId;
};

/** What the drop does with the dragged chat (or the dragged pane's). */
export function applyDrop(action: DropAction, chatId: string) {
  switch (action.kind) {
    case 'split':
      return void openInSplit(chatId, action.at);
    case 'here':
      if (action.target === 'primary') return navigate({ name: 'thread', id: chatId });
      return void applySplitOp({ op: 'replace', chatId: action.target, next: chatId });
    case 'swap':
      return void applySplitOp({ op: 'swap', a: chatId, b: action.target });
    case 'move':
      return void applySplitOp({ op: 'move', chatId, to: action.to });
  }
}

/** The panes' boxes, relative to the frame, read from their roots (`data-split-target`). */
function paneBoxes(frame: HTMLElement): PaneBox[] {
  const origin = frame.getBoundingClientRect();
  return [...frame.querySelectorAll<HTMLElement>(':scope > [data-split-target]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      // every element the selector matched carries it
      target: el.dataset.splitTarget as string,
      left: r.left - origin.left,
      right: r.right - origin.left,
      top: r.top - origin.top,
      bottom: r.bottom - origin.top,
    };
  });
}

/** The frame's drag handlers and the zone to draw while something it takes is dragged over it. */
export function useSplitDrop(frame: RefObject<HTMLElement | null>) {
  const [zone, setZone] = useState<DropZone | null>(null);
  const read = (e: DragEvent) => {
    const el = frame.current;
    const pane = e.dataTransfer.types.includes(PANE_DRAG);
    const source = draggedPane;
    if (!el || (pane ? !source : !e.dataTransfer.types.includes(CHAT_DRAG))) return null;
    const origin = el.getBoundingClientRect();
    return dropZone(
      paneBoxes(el),
      e.clientX - origin.left,
      e.clientY - origin.top,
      source && pane ? { kind: 'pane', chatId: source } : { kind: 'chat' },
    );
  };
  return {
    zone,
    onDragOver: (e: DragEvent) => {
      const next = read(e);
      setZone(next);
      if (!next) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    },
    onDragLeave: (e: DragEvent) => {
      // leaving for one of the frame's own children is still over it
      if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setZone(null);
    },
    onDrop: (e: DragEvent) => {
      const next = read(e);
      setZone(null);
      if (!next) return;
      e.preventDefault();
      const chatId = e.dataTransfer.getData(e.dataTransfer.types.includes(PANE_DRAG) ? PANE_DRAG : CHAT_DRAG);
      if (chatId) applyDrop(next.action, chatId);
    },
  };
}
