// Whether an element is on screen, from one IntersectionObserver every caller shares: a sidebar row reads its chat's pull
// request only while it can be seen, so a long sidebar no longer reads every chat's whole history at launch.
import { useEffect, useState, type RefObject } from 'react';

type Listener = (on: boolean) => void;
/** Each watched element: every caller watching it (two may watch one row), and the observer's last report for it. */
const watched = new Map<Element, { listeners: Set<Listener>; on: boolean | null }>();
let observer: IntersectionObserver | null = null;

function shared(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const w = watched.get(entry.target);
      if (!w) continue;
      w.on = entry.isIntersecting;
      for (const listener of w.listeners) listener(w.on);
    }
  });
  return observer;
}

/**
 * Whether `ref`'s element intersects the viewport (inside every scrolling ancestor's clip), kept current as it scrolls,
 * folds away or comes back. False until the observer's first report; true where there is nothing to judge by (no ref,
 * no element, or no IntersectionObserver), so a caller is never stuck waiting on a report that cannot come.
 */
export function useOnScreen(ref: RefObject<Element | null> | null): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!ref) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') {
      setOn(true);
      return;
    }
    const own: Listener = (value) => setOn(value);
    let w = watched.get(el);
    if (w) {
      // observing an element twice reports nothing new: a second caller starts from the last report
      if (w.on !== null) setOn(w.on);
    } else {
      w = { listeners: new Set(), on: null };
      watched.set(el, w);
      shared().observe(el);
    }
    const mine = w;
    mine.listeners.add(own);
    return () => {
      mine.listeners.delete(own);
      if (mine.listeners.size) return;
      watched.delete(el);
      observer?.unobserve(el);
    };
  }, [ref]);
  return ref ? on : true;
}
