// Room under the latest turn, so a message just sent sits near the top of the view while its reply grows below it, as
// Claude and ChatGPT desktop place a sent message (#1779), and whether anything but that room lies below the view.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { turnSlots, viewHeight } from './turnWindow';

/** How far below the top of the view a placed message sits: where a jump to a message puts it (messageJumps). */
export const PLACED_GAP = 16;
/** Content further below the view than this, beyond the room, is worth the scroll-to-bottom button. */
const BELOW_PX = 40;

/** The room a turn needs under it to sit `gap` below the top of a `viewport`-high view, given its content and what follows. */
export function responseSpace(viewport: number, contentAfter: number, gap = PLACED_GAP): number {
  return Math.max(0, Math.floor(viewport - gap - contentAfter));
}

/** Whether `next` ends in a turn `previous` did not have: a send, not older history going in above or a turn renamed. */
export function addedTurn(previous: readonly { id: string }[], next: readonly { id: string }[]): boolean {
  const last = next.at(-1);
  return !!last && next.length > previous.length && !previous.some((turn) => turn.id === last.id);
}

/** The message a placement scrolls to: the latest turn's first, if it has one. */
export function latestMessage(scroll: Element): HTMLElement | null {
  const slots = turnSlots(scroll);
  return slots[slots.length - 1]?.querySelector<HTMLElement>('[data-navigation-id]') ?? null;
}

export interface ResponseSpace {
  /** the room's element, the last thing in the transcript's column */
  ref: (element: HTMLDivElement | null) => void;
  /** make room under the latest turn, and keep it as the turn grows into it */
  place: () => void;
  /** no room: the transcript ends where its content does */
  clear: () => void;
  /** re-measure after the view moved */
  measure: () => void;
  /** whether content, not just the room, lies below the view */
  below: boolean;
}

/** The room for one chat's latest turn: none until a turn is placed, and none again when the chat changes. */
export function useResponseSpace(scope: string): ResponseSpace {
  const element = useRef<HTMLDivElement | null>(null);
  const on = useRef(false);
  const height = useRef(0);
  const [below, setBelow] = useState(true);

  const measure = useCallback(() => {
    const room = element.current;
    if (!room) return;
    const scroll = room.closest<HTMLElement>('.thread-scroll')!;
    // the room itself is not content: measure from the placed message to where the room starts
    const message = on.current ? latestMessage(scroll) : null;
    const next = message ? responseSpace(viewHeight(scroll), room.getBoundingClientRect().top - message.getBoundingClientRect().top) : 0;
    if (next !== height.current) {
      height.current = next;
      room.style.height = `${next}px`;
    }
    setBelow(!on.current || scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop - next > BELOW_PX);
  }, []);

  const place = useCallback(() => {
    on.current = true;
    measure();
  }, [measure]);
  const clear = useCallback(() => {
    on.current = false;
    measure();
  }, [measure]);
  useEffectOn([scope], () => {
    clear();
  });

  // the turn grows into the room, and a taller or shorter view needs more or less of it. A ref that returns its
  // cleanup is called with its element only (React 19); the room sits in the transcript's column, in its scroller.
  const ref = useCallback(
    (room: HTMLDivElement | null) => {
      element.current = room;
      height.current = 0;
      const observer = new ResizeObserver(measure);
      observer.observe(room!.closest('.thread-scroll')!);
      observer.observe(room!.parentElement!);
      return () => {
        observer.disconnect();
        element.current = null;
      };
    },
    [measure],
  );

  return useMemo(() => ({ ref, place, clear, measure, below }), [ref, place, clear, measure, below]);
}
