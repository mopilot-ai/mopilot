// Which messages of a thread are on screen, for the navigation rail: watched with an IntersectionObserver on the
// rendered prompts, read with a binary search over their positions only when one crosses the viewport's edges.

import { useState, type RefObject } from 'react';
import { useEffectOn } from '../../lib/effects';
import { visibleEntries } from '../../lib/turnWindow';

// A turn counts as on screen once it reaches this far below the transcript's top edge (Codex's rootMargin).
const VISIBLE_INSET = 16;
const NO_IDS: ReadonlySet<string> = new Set<string>();

/** Current prompt positions in rail order, from one DOM scan; missing prompts are virtualized placeholders. */
export function navigationTops(scroll: HTMLElement, items: readonly { id: string }[]): (number | undefined)[] {
  const anchors = new Map<string, HTMLElement>();
  for (const anchor of scroll.querySelectorAll<HTMLElement>('[data-navigation-id]')) {
    const id = anchor.dataset.navigationId!;
    if (!anchors.has(id)) anchors.set(id, anchor);
  }
  return items.map((item) => anchors.get(item.id)?.getBoundingClientRect().top);
}

/**
 * The navigation ids (of `itemKey`, one per line) whose messages are on screen in `scrollRef`'s transcript. Every turn
 * with any part on screen is current, as in Codex; a turn runs from its prompt to the next prompt, so a long reply
 * keeps its turn current after the prompt has left the viewport. Which turns are on screen changes only when a prompt
 * crosses the viewport's top line or its bottom, so an IntersectionObserver on the rendered prompts says when to look;
 * a look reads only the prompts it needs. A streamed reply growing, which moves no prompt across those edges, reads
 * nothing. A jump that carries a prompt past the viewport between two frames (a scroll bar drag) is read once the
 * scroll ends. Message ids stay as response text streams; `rendered` (the turns the transcript renders) changes which
 * prompts there are to observe.
 */
export function useVisibleMessages(
  scrollRef: RefObject<HTMLElement | null>,
  itemKey: string,
  rendered: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(NO_IDS);
  useEffectOn([scrollRef, itemKey, rendered], () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const ids = new Set(itemKey.split('\n'));
    const targets = [...scroll.querySelectorAll<HTMLElement>('[data-navigation-id]')].filter((a) => ids.has(a.dataset.navigationId!));
    let frame = 0;
    const update = () => {
      frame = 0;
      const view = scroll.getBoundingClientRect();
      const end = view.top - scroll.scrollTop + scroll.scrollHeight;
      const tops = new Map<number, number>();
      const topOf = (i: number) => {
        let top = tops.get(i);
        if (top === undefined) tops.set(i, (top = targets[i].getBoundingClientRect().top));
        return top;
      };
      const visible = new Set(
        visibleEntries(targets.length, topOf, { top: view.top, bottom: view.bottom, end }, VISIBLE_INSET).map(
          (i) => targets[i].dataset.navigationId!,
        ),
      );
      setVisibleIds((previous) => (previous.size === visible.size && [...visible].every((id) => previous.has(id)) ? previous : visible));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new IntersectionObserver(schedule, { root: scroll, rootMargin: `-${VISIBLE_INSET}px 0px 0px 0px`, threshold: [0, 1] });
    for (const target of targets) observer.observe(target);
    scroll.addEventListener('scrollend', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroll.removeEventListener('scrollend', schedule);
    };
  });
  return visibleIds;
}

/**
 * The message Alt+Down (`down`) or Alt+Up goes to, as an index into the rail's messages, from their prompts' tops
 * (undefined for a message whose turn is a placeholder, with no prompt rendered) and the line it goes from. Down: the
 * message after the last rendered prompt at or above the line, else the first rendered one below it. Up: the message
 * before the first rendered prompt at or below the line, else the last rendered one above it. So a message whose turn
 * is a placeholder (after a reply taller than the window's margin) is reached in the rail's order. -1 or past the end
 * when there is none.
 */
export function adjacentMessage(tops: readonly (number | undefined)[], line: number, down: boolean): number {
  if (down) {
    const above = tops.findLastIndex((t) => t !== undefined && t <= line);
    return above >= 0 ? above + 1 : tops.findIndex((t) => t !== undefined && t > line);
  }
  const below = tops.findIndex((t) => t !== undefined && t >= line);
  return below >= 0 ? below - 1 : tops.findLastIndex((t) => t !== undefined && t < line);
}
