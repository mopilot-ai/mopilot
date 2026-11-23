// Where a popover goes for its anchor and the room around it (Popover.tsx): the placement asked for, moved to stay on screen.

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'right-end' | 'bottom' | 'top';

type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width'>;

/**
 * The popover's corner, and `below`: a top placement opened below its anchor. No room above an anchor high on screen
 * puts it below, rather than clamped over the anchor, when it fits there. The caller passes `below` back while the popover
 * stays open: content shrinking under the user's pointer mustn't send the whole popover back above.
 */
export function placePopover(
  placement: Placement,
  r: Box,
  size: { w: number; h: number },
  offset: number,
  viewport: { w: number; h: number },
  wasBelow: boolean,
): { left: number; top: number; below: boolean } {
  const { w, h } = size;
  let left = r.left;
  let top = r.bottom + offset;
  switch (placement) {
    case 'bottom-end':
      left = r.right - w;
      break;
    case 'bottom':
      left = r.left + r.width / 2 - w / 2;
      break;
    case 'top-start':
      top = r.top - h - offset;
      break;
    case 'top-end':
      top = r.top - h - offset;
      left = r.right - w;
      break;
    case 'top':
      top = r.top - h - offset;
      left = r.left + r.width / 2 - w / 2;
      break;
    case 'right-start':
      left = r.right + offset;
      top = r.top - 5;
      break;
    case 'right-end':
      left = r.right + offset;
      top = r.bottom - h + 5;
      break;
  }
  if (top + h > viewport.h - 8) top = Math.max(8, placement.startsWith('bottom') ? r.top - h - offset : viewport.h - h - 8);
  let below = wasBelow;
  if (placement.startsWith('top') && (below || top < 8) && r.bottom + offset + h <= viewport.h - 8) {
    below = true;
    top = r.bottom + offset;
  }
  if (top < 8) top = 8;
  if (left + w > viewport.w - 8) left = placement.startsWith('right') ? r.left - w - offset : viewport.w - w - 8;
  if (left < 8) left = 8;
  return { left, top, below };
}
