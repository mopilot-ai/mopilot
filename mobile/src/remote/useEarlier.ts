// The older rows a chat screen has loaded above the snapshot, the state of asking for more, and the request itself.
import { useCallback, useRef, useState } from 'react';
import type { Data, Thread } from '../presentation/thread';
import { type Owned, explain, str } from './client';
import { oldestId, readEarlier } from './earlier';

/** A scroll within this many points of the top asks for the page before. */
export const NEAR_TOP = 120;
type Scrolled = { nativeEvent?: { contentOffset?: { y?: number } } };
/** Rows already on the phone that are not mounted yet: how many, and the way to mount a page of them. */
type Local = { hidden: number; reveal: () => void };

export function useEarlier(request: Owned, chatId: string) {
  const [rows, setRows] = useState<Data[]>([]);
  // null until a page says whether the chat goes back further
  const [more, setMore] = useState<boolean | null>(null);
  const [omitted, setOmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  // a finger on the list: one gesture asks for at most one page. A scroll event with no finger behind it (the list moving to hold a row when a page lands, a jump to the end) asks for nothing, or a page that did not hold the reader's place would ask for the next, and the next, down to the start of the chat (#4734)
  const armed = useRef(false);
  // the oldest row of the first snapshot: a live turn starting rebuilds the thread's rows without their ids
  const base = useRef<string | null>(null);
  // the oldest row shown, updated as a page lands: a scroll between the page landing and the screen drawing it must not ask for the page again
  const oldest = useRef<string | null>(null);
  // counts the times the chat was read again, so a page that was on its way then is not added to the new snapshot
  const era = useRef(0);
  /** Where the page before the oldest row shown starts, or null when no row can be named. */
  const cursor = (thread: Thread | null) => {
    if (thread && base.current === null) base.current = oldestId(thread);
    return oldest.current ?? base.current;
  };
  /** Asks for the page before the oldest row shown; one request at a time. */
  async function load(thread: Thread) {
    const before = cursor(thread);
    if (!before || running.current) return;
    const mine = era.current;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = await readEarlier(request, chatId, before);
      if (mine !== era.current) return;
      oldest.current = str(page.rows[0]?.id) ?? oldest.current;
      setRows((old) => [...page.rows, ...old]);
      setMore(page.more);
      setOmitted(page.omitted);
    } catch (e) {
      if (mine === era.current) setError(explain(e));
    } finally {
      if (mine === era.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const grab = () => {
    armed.current = true;
  };
  // the gesture is over: when the finger lifts with no momentum behind it, or when the list stops
  const release = () => {
    armed.current = false;
  };
  const scrolled = (thread: Thread, event: Scrolled, local?: Local) => {
    if (!armed.current || (event.nativeEvent?.contentOffset?.y ?? Infinity) > NEAR_TOP) return;
    // rows the phone holds but has not mounted come first; the computer is asked once they are all shown
    if (local?.hidden) {
      armed.current = false;
      local.reveal();
      return;
    }
    if (more === false || error) return;
    armed.current = false;
    void load(thread);
  };
  return {
    rows,
    more,
    omitted,
    error,
    busy,
    cursor,
    load,
    /** What the row above the first message shows and does: held rows are mounted before the computer is asked. */
    row: (thread: Thread | null, local?: Local) => ({
      more: more !== false || !!local?.hidden,
      omitted,
      busy,
      error,
      load: () => (local?.hidden ? local.reveal() : thread && void load(thread)),
    }),
    /** A finger went down on the list: the gesture may ask for one page. */
    grab,
    /** A scroll under a finger that reaches the top asks for the page before, once, unless the chat starts there or the last ask failed (the person retries that one, so a held-down finger does not repeat it). */
    scrolled,
    /** The ScrollView's handlers: a finger arms the gesture until the finger lifts with no momentum or the list stops (a scroll with no finger asks for nothing), and the list's own `onScroll` runs before a scroll under it may ask for a page. */
    listProps: <E extends Scrolled>(
      thread: Thread | null,
      list: {
        onScroll: (event: E) => void;
        onScrollBeginDrag: () => void;
        onScrollEndDrag: (event?: { nativeEvent?: { velocity?: { y?: number } } }) => void;
        onMomentumScrollEnd: () => void;
      },
      local?: Local,
    ) => ({
      onScrollBeginDrag: () => {
        list.onScrollBeginDrag();
        grab();
      },
      onScrollEndDrag: (event: { nativeEvent?: { velocity?: { y?: number } } }) => {
        list.onScrollEndDrag(event);
        if (!event?.nativeEvent?.velocity?.y) release();
      },
      onMomentumScrollEnd: () => {
        list.onMomentumScrollEnd();
        release();
      },
      onScroll: (event: E) => {
        list.onScroll(event);
        if (thread) scrolled(thread, event, local);
      },
    }),
    /** Forgets what was loaded, for a chat that was read again from the start. */
    reset: useCallback(() => {
      era.current++;
      running.current = false;
      armed.current = false;
      base.current = null;
      oldest.current = null;
      setRows([]);
      setMore(null);
      setOmitted(false);
      setError(null);
      setBusy(false);
    }, []),
  };
}
