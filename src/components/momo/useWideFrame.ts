// Whether MoMo's page has room for the right panel beside the chat column: the frame's width, followed as the window or the side panel changes, against the width the column and the panel need together.
import { useEffect, useRef, useState } from 'react';

/** The chat column (736px and its 24px margins) and the panel (360px) with their gaps. */
export const PANEL_ROOM = 1200;

export function useWideFrame() {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= PANEL_ROOM));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return { ref, wide };
}
