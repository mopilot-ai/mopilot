// Loading an older page of a thread's history while keeping the reader's scroll position.

import { navigationAnchor } from './threadNavigation';

export interface HistoryPageDependencies {
  scroll: HTMLElement;
  load: () => Promise<void>;
  afterPaint: () => Promise<void>;
  isCurrent: () => boolean;
  target: () => string | null;
  navigate: (id: string) => void;
  onError: (error: unknown) => void;
}

/** Transcripts with a page load in flight, and how many: their browser scroll anchoring is off meanwhile. */
const pausedAnchoring = new WeakMap<HTMLElement, number>();

/** Keep the reader's position while older messages prepend and a live reply grows elsewhere. */
export async function loadHistoryPage({ scroll, load, afterPaint, isCurrent, target, navigate, onError }: HistoryPageDependencies) {
  const anchor = scroll.querySelector<HTMLElement>('[data-navigation-id]');
  const documentTop = (element: HTMLElement) => element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  const before = anchor ? documentTop(anchor) : scroll.scrollHeight;
  const previousHeight = scroll.scrollHeight;
  // This restores the place itself, by the page's height, so the browser's scroll anchoring must not also move the
  // view for the page going in above it: the two together scrolled a page too far. Off only until the place is set.
  // Counted per transcript: a load for another chat can start in the same transcript before this one settles.
  pausedAnchoring.set(scroll, (pausedAnchoring.get(scroll) ?? 0) + 1);
  scroll.style.overflowAnchor = 'none';
  try {
    await load();
    await afterPaint();
    if (!isCurrent()) return;
    const destination = target();
    if (destination && navigationAnchor(scroll, destination)) navigate(destination);
    else if (anchor?.isConnected) scroll.scrollTop += documentTop(anchor) - before;
    else scroll.scrollTop += scroll.scrollHeight - previousHeight;
  } catch (error) {
    if (isCurrent()) onError(error);
  } finally {
    const left = pausedAnchoring.get(scroll)! - 1;
    if (left) pausedAnchoring.set(scroll, left);
    else {
      pausedAnchoring.delete(scroll);
      scroll.style.removeProperty('overflow-anchor');
    }
  }
}
