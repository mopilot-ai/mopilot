// The window of a long thread: turns near the viewport render in full, every other turn is a placeholder of its last
// measured height, and the reader's place is kept while they swap.

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { TurnState } from '../../../store/types';
import {
  anchorCorrection,
  estimateTurnHeight,
  firstBelow,
  initialWindow,
  sameOrNext,
  turnPreview,
  WINDOW_SCREENS,
} from '../../../lib/turnWindow';

const NONE: ReadonlySet<string> = new Set();

export interface TurnWindow {
  /** the turns that render in full; its identity changes only when they do */
  mounted: ReadonlySet<string>;
  /** a turn's last measured height, or its estimate before it ever rendered */
  heightOf: (id: string) => number;
  /** the callback ref for a turn's slot (stable per turn) */
  slotRef: (id: string) => (element: HTMLDivElement | null) => void;
}

/**
 * Which turns of `turns` render in full. Until `armed` (the chat has scrolled to where it opens, its bottom), the last
 * turns that fill the viewport and the margin above it. Then the turns an IntersectionObserver reports within
 * {@link WINDOW_SCREENS} screens of the viewport, plus `pinned` ones, plus the turn holding the focus and, while text
 * is selected in the transcript, the rendered turns the selection runs through, so they stay. Without an
 * IntersectionObserver every turn renders.
 */
export function useTurnWindow({
  scope,
  scrollRef,
  turns,
  pinned,
  armed,
}: {
  /** the chat: another chat's turns start with no measured heights */
  scope: string;
  scrollRef: RefObject<HTMLElement | null>;
  turns: TurnState[];
  pinned: readonly (string | null | undefined)[];
  armed: boolean;
}): TurnWindow {
  const heights = useRef(new Map<string, number>());
  const heightScope = useRef(scope);
  if (heightScope.current !== scope) {
    heightScope.current = scope;
    heights.current = new Map();
  }
  const slots = useRef(new Map<string, HTMLDivElement>());
  const refs = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const near = useRef(new Set<string>());
  // whether the transcript has reported what is on screen at least once: until it has, `near` is empty and says nothing
  const observed = useRef(false);
  const observers = useRef<{ intersection: IntersectionObserver | null; resize: ResizeObserver | null }>({
    intersection: null,
    resize: null,
  });
  const byId = useRef(new Map<string, TurnState>());
  byId.current = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns]);
  // null until the transcript first reports what is on screen; a report is the chat's it was made for, so another
  // chat's first render (before its own report) opens on its own last turns, not on ids of the last chat
  const [reported, setReported] = useState<{ scope: string; ids: ReadonlySet<string> } | null>(null);
  const scopeNow = useRef(scope);
  scopeNow.current = scope;
  const shown = useRef<ReadonlySet<string>>(NONE);
  const windowed = typeof IntersectionObserver === 'function';

  // a turn that never rendered keeps its estimate: scaling every estimate by what was measured would move every
  // placeholder each time a turn is measured, and the view with them
  const heightOf = useCallback((id: string) => {
    const measured = heights.current.get(id);
    if (measured !== undefined) return measured;
    const turn = byId.current.get(id);
    return turn ? estimateTurnHeight(turn) : 0;
  }, []);

  /** What is near the viewport, and what must stay rendered for now (the focus, a selection in the transcript). */
  const settle = useCallback(() => {
    const scroll = scrollRef.current;
    // The opening window stands until the transcript's first report: before it, `near` is empty, so starting from
    // it would let a selection (or the focus) cut the window down to the one turn it holds and replace every other
    // turn on screen with a placeholder. A selection adds to what renders; it never decides what renders.
    const next = new Set(observed.current ? near.current : [...near.current, ...shown.current]);
    const selection = document.getSelection();
    const range =
      scroll &&
      selection &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      scroll.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0)
        : null;
    for (const id of shown.current) {
      const slot = slots.current.get(id);
      if (!slot) continue;
      // the turns a selection in the transcript runs through, and the one holding the focus
      if (
        range?.intersectsNode(slot) ||
        (document.activeElement && slot !== document.activeElement && slot.contains(document.activeElement))
      )
        next.add(id);
    }
    const current = scopeNow.current;
    // a report that changes nothing (a selection change in the composer) renders nothing
    setReported((previous) => {
      if (previous?.scope !== current) return { scope: current, ids: next };
      const ids = sameOrNext(previous.ids, next);
      return ids === previous.ids ? previous : { scope: current, ids };
    });
  }, [scrollRef]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!armed || !windowed || !scroll) return;
    const resize = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.turnSlot;
        // a placeholder keeps the height it was given: only a rendered turn is measured
        if (id && (entry.target as HTMLElement).childElementCount)
          heights.current.set(id, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      }
    });
    const intersection = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.turnSlot!;
          if (entry.isIntersecting) near.current.add(id);
          else near.current.delete(id);
        }
        observed.current = true;
        settle();
      },
      { root: scroll, rootMargin: `${WINDOW_SCREENS * 100}% 0px` },
    );
    observers.current = { intersection, resize };
    for (const slot of slots.current.values()) {
      intersection.observe(slot);
      resize.observe(slot);
    }
    // a selection that ends, or a focus that leaves, lets the turns it kept go
    document.addEventListener('selectionchange', settle);
    scroll.addEventListener('focusout', settle);
    return () => {
      intersection.disconnect();
      resize.disconnect();
      observers.current = { intersection: null, resize: null };
      near.current.clear();
      observed.current = false;
      document.removeEventListener('selectionchange', settle);
      scroll.removeEventListener('focusout', settle);
      setReported(null);
    };
  }, [armed, windowed, scrollRef, settle]);

  const slotRef = useCallback((id: string) => {
    let ref = refs.current.get(id);
    if (!ref) {
      let current: HTMLDivElement | null = null;
      ref = (element) => {
        const { intersection, resize } = observers.current;
        if (current) {
          intersection?.unobserve(current);
          resize?.unobserve(current);
          if (slots.current.get(id) === current) slots.current.delete(id);
          // a turn that left the thread is no longer near anything, and needs no ref of its own
          if (!element) {
            near.current.delete(id);
            refs.current.delete(id);
          }
        }
        current = element;
        if (element) {
          slots.current.set(id, element);
          intersection?.observe(element);
          resize?.observe(element);
        }
      };
      refs.current.set(id, ref);
    }
    return ref;
  }, []);

  const idKey = turns.map((t) => t.id).join('\n');
  const pinKey = pinned.filter(Boolean).join('\n');
  const mounted = useMemo(() => {
    if (!windowed) return new Set(idKey.split('\n'));
    const pins = pinKey ? pinKey.split('\n') : [];
    const base =
      (reported?.scope === scope ? reported.ids : null) ??
      initialWindow(idKey ? idKey.split('\n') : [], heightOf, (WINDOW_SCREENS + 1) * viewHeight(scrollRef.current));
    return new Set([...base, ...pins]);
  }, [windowed, reported, scope, idKey, pinKey, heightOf, scrollRef]);
  const stable = useRef<ReadonlySet<string>>(mounted);
  stable.current = sameOrNext(stable.current, mounted);
  shown.current = stable.current;

  return { mounted: stable.current, heightOf, slotRef };
}

/**
 * The props of a turn's slot that depend on whether it renders in full. A turn the window has not rendered keeps the
 * height it last had and draws its words (the first prompt and the start of the last reply, src/styles/app/thread.css),
 * not a blank, while the window catches up. `folded` is a run of woken turns, which draws as one row and not as the
 * words of its first turn.
 */
export function placeholderProps(turn: TurnState, full: boolean, folded: boolean, heightOf: (id: string) => number) {
  if (full) return {};
  const { prompt, reply } = folded ? { prompt: '', reply: '' } : turnPreview(turn);
  return {
    style: { height: heightOf(turn.id) },
    'data-prompt': prompt || undefined,
    'data-reply': reply || undefined,
    'aria-hidden': prompt || reply ? true : undefined,
  };
}

/**
 * The height of the transcript's view: its scroller's, or the window's while it has not laid out, and never more than
 * the window's. A host that does not bound the scroller's height lets it grow with its content; sized from that alone,
 * what fills the view (the response room, view/responseSpace.ts) would grow from its own height without end (#2277).
 */
export function viewHeight(scroll: HTMLElement | null): number {
  return Math.min(scroll?.clientHeight || window.innerHeight, window.innerHeight);
}

interface Anchor {
  slot: HTMLElement;
  top: number;
}

/**
 * Keeps the first turn on screen where it is when the window changes: turns that swap with placeholders above it
 * shift it by the difference between their real and placeholder heights, so the transcript scrolls by that much. The
 * position is read just before React changes the DOM (getSnapshotBeforeUpdate) and again just after, before paint.
 * Skipped while `hold` says so: when the view follows its bottom, or a smooth jump is on its way.
 */
export class KeepAnchor extends Component<{
  scrollRef: RefObject<HTMLElement | null>;
  mounted: ReadonlySet<string>;
  hold: () => boolean;
  children?: ReactNode;
}> {
  getSnapshotBeforeUpdate(previous: { mounted: ReadonlySet<string> }): Anchor | null {
    const scroll = this.props.scrollRef.current;
    if (previous.mounted === this.props.mounted || !scroll || this.props.hold()) return null;
    return visibleAnchor(scroll);
  }

  componentDidUpdate(_previous: unknown, _state: unknown, anchor: Anchor | null) {
    const scroll = this.props.scrollRef.current;
    if (!anchor || !scroll || !anchor.slot.isConnected) return;
    scroll.scrollTop += anchorCorrection(anchor.top, offsetIn(scroll, anchor.slot));
  }

  render() {
    return this.props.children;
  }
}

/**
 * The turn slot to hold in place and how far below the viewport's top it starts: the first one that starts on screen,
 * as the browser's own scroll anchoring picks, so the two agree and this one has nothing left to move (a write would
 * stop a smooth scroll); or, when one turn fills the screen, that turn.
 */
export function visibleAnchor(scroll: HTMLElement): Anchor | null {
  const all = turnSlots(scroll);
  const view = scroll.getBoundingClientRect();
  const tops = new Map<number, number>();
  const topOf = (i: number) => {
    let top = tops.get(i);
    if (top === undefined) tops.set(i, (top = all[i].getBoundingClientRect().top));
    return top;
  };
  let index = firstBelow(all.length, topOf, view.top - 0.5);
  if (index > 0 && (index === all.length || topOf(index) >= view.bottom)) index--;
  return index < all.length ? { slot: all[index], top: topOf(index) - view.top } : null;
}

/** The transcript's turn slots, in order. */
export const turnSlots = (scroll: Element) => scroll.querySelectorAll<HTMLElement>(':scope > .thread-column > [data-turn-slot]');

const offsetIn = (scroll: HTMLElement, element: HTMLElement) => element.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
