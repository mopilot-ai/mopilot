// "Show more" at the end of the sidebar list: loading the next page of Codex chats on click or scroll.

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadThreads } from '../../store/connection';
import { useStore } from '../../store/core';

/**
 * The end of the sidebar list when Codex has more chats than the first page. "Show more" loads the next
 * page, and so does scrolling the sidebar to its end (only on a scroll, so pages never chain by themselves).
 */
export function MoreChats() {
  const cursor = useStore((s) => s.threadsCursor);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  // A ref, not `busy`: scroll events that arrive before the re-render still see the request in flight.
  const loading = useRef(false);
  // reads only refs and setters: one function for every render, so the scroll listener needs no refresh
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    try {
      await loadThreads(true);
    } finally {
      loading.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const scroller = ref.current?.closest('.sidebar-scroll');
    if (!scroller || !cursor || busy) return;
    const onScroll = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80 && load();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [cursor, busy, load]);
  if (!cursor) return null;
  return (
    <button ref={ref} className="side-row muted" data-testid="more-chats" disabled={busy} onClick={load}>
      <span className="side-row-label">{busy ? 'Loading…' : 'Show more chats'}</span>
    </button>
  );
}
