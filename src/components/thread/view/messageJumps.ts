// Jumps in a thread's transcript: to a message (the navigation rail, a bookmark) or back to the bottom, through a
// window of rendered turns, finishing where the content ends up once a smooth scroll is over.

import { useCallback, useRef, useState, type RefObject } from 'react';
import type { TurnState } from '../../../store/types';
import { navigationAnchor, navigationTurn } from '../../../session/threadNavigation';
import { useEffectOn } from '../../../lib/effects';

/** How long a smooth scroll the view started counts as under way, should its end never be announced. */
const AIM_MS = 2000;

export interface MessageJumps {
  /** the message the last jump went to, until the reader scrolls (older history pages back to it) */
  target: RefObject<string | null>;
  /** the turn that jump went to: it renders wherever it is */
  turn: string | null;
  navigateTo: (id: string, instant?: boolean) => void;
  /** a smooth scroll to the bottom starts: where it ends, the view follows the bottom again */
  toBottom: () => void;
  /** the reader scrolled: no jump is kept or finished */
  forget: () => void;
  /** whether a smooth scroll the view started is on its way: moving the view now would stop it */
  aiming: () => boolean;
  /** the transcript's `onScrollEnd`: a smooth jump, or the scroll to the bottom, finishes there */
  onScrollEnd: () => void;
}

/**
 * A jump to a message whose turn is not rendered renders the turn first and then goes there at once: a smooth scroll
 * across placeholders would land where they were, not where the turns that replace them put the message. A smooth
 * jump or scroll to the bottom finishes once its scroll ends, since turns that rendered on the way moved its end.
 */
export function useMessageJumps({
  scrollRef,
  turns,
  follow,
  onJump,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  turns: TurnState[];
  /** the view follows its bottom, or stops */
  follow: (on: boolean) => void;
  /** a jump left the bottom */
  onJump: () => void;
}): MessageJumps {
  const target = useRef<string | null>(null);
  const [turn, setTurn] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  // counts jumps that wait for their turn to render: the pinned turn can be the same one again
  const [waiting, setWaiting] = useState(0);
  const aim = useRef<{ id: string | null; until: number } | null>(null);
  const turnsNow = useRef(turns);
  turnsNow.current = turns;

  /** Scroll to a rendered message: false when it is not rendered. */
  const scrollToMessage = useCallback(
    (id: string, instant: boolean) => {
      const scroll = scrollRef.current;
      const anchor = scroll && navigationAnchor(scroll, id);
      if (!scroll || !anchor) return false;
      // where the scroll can go: a message near the end cannot reach the top, and a scroll that does not move ends no scroll
      const top = Math.max(
        0,
        Math.min(
          scroll.scrollHeight - scroll.clientHeight,
          scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16,
        ),
      );
      const smooth = !instant && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && Math.abs(top - scroll.scrollTop) >= 1;
      aim.current = smooth ? { id, until: performance.now() + AIM_MS } : null;
      scroll.scrollTo({ top, behavior: smooth ? 'smooth' : 'instant' });
      return true;
    },
    [scrollRef],
  );

  const navigateTo = useCallback(
    (id: string, instant = false) => {
      const turnId = scrollRef.current && navigationTurn(turnsNow.current, id);
      if (!turnId) return;
      target.current = id;
      follow(false);
      onJump();
      setTurn(turnId);
      pending.current = scrollToMessage(id, instant) ? null : id;
      if (pending.current) setWaiting((n) => n + 1);
    },
    [scrollRef, scrollToMessage, follow, onJump],
  );
  // the turn renders in the commit that pins it: go to its message now
  useEffectOn([waiting], () => {
    const id = pending.current;
    pending.current = null;
    if (id && target.current === id) scrollToMessage(id, true);
  });
  const onScrollEnd = useCallback(() => {
    const scroll = scrollRef.current;
    const jump = aim.current;
    aim.current = null;
    // a scroll that ended long after the one the view started (that one never moved) is someone else's
    if (!scroll || !jump || performance.now() >= jump.until) return;
    if (jump.id === null) {
      // turns that rendered on the way to the bottom made it lower than where the scroll was headed
      scroll.scrollTop = scroll.scrollHeight;
      follow(true);
    } else if (target.current === jump.id) scrollToMessage(jump.id, true);
  }, [scrollRef, scrollToMessage, follow]);

  const toBottom = useCallback(() => {
    const scroll = scrollRef.current!;
    // No movement means no scrollend: do not hold off resize following for a jump that cannot start.
    aim.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1 ? { id: null, until: performance.now() + AIM_MS } : null;
  }, [scrollRef]);
  const forget = useCallback(() => {
    target.current = null;
    pending.current = null;
    aim.current = null;
    setTurn(null);
  }, []);
  const aiming = useCallback(() => !!aim.current && performance.now() < aim.current.until, []);
  return { target, turn, navigateTo, toBottom, forget, aiming, onScrollEnd };
}
