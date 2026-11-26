// The older rows a chat screen has loaded above the snapshot, the state of asking for more, and the request itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Data, Thread } from '../presentation/thread';
import { type Owned, explain, str } from './client';
import { usePagesHeld } from './usePagesHeld';
import { useGestureQueue } from './useGestureQueue';
import { AppState } from 'react-native';
import { AHEAD_PAGE, earlierRow, keptAbove, newRows, oldestId, readEarlier } from './earlier';
import type { PageCache, PageSnapshot } from './pageCache';

/** A scroll within this many points of the top, under a finger, asks for the page before. */
export const NEAR_TOP = 120;
/** A scroll within this many screens of the top (and at least AHEAD_MIN points) asks for the page before with no finger needed, so the rows are there before the reader arrives. */
export const AHEAD_SCREENS = 3;
export const AHEAD_MIN = 1500;
/** Pages asked for one after another with no finger on the list: past this, a list that does not hold the reader's place would run down to the start of the chat (#4734), so a finger must ask. */
export const MAX_CHAIN = 4;
/** After a page lands, scroll reports made before the screen drew it (an offset from before the page) ask for nothing for this long (ms). */
export const SETTLE_MS = 300;
/**
 * The rows filled above the snapshot in the background: a page of BACKFILL_PAGE every `gap` ms, at most `rows` rows and `bytes` of their text
 * held. The fill is silent (it shows no row and no error) and polite: it waits while a turn streams, while the app is not in front, while a
 * finger is on the list, and after a failure for `retry` ms (doubling, up to `retryMax`), FILL_RETRIES times in a row at most. The values are
 * fields so that a test can run the same loop at a thousandth of the pace.
 */
export const backfill = { rows: 1000, bytes: 1_500_000, gap: 250, retry: 5000, retryMax: 60_000, save: 5000 };
export const BACKFILL_PAGE = 100;
export const FILL_RETRIES = 5;
const STREAMING = new Set(['running', 'inProgress']);
/** The app is away or on its way away (the switcher, a call): background work waits. */
const inBackground = () => AppState.currentState === 'background' || AppState.currentState === 'inactive';
/** What a page that adds nothing, though the computer says the chat goes back further, shows. */
const NO_PROGRESS = 'Earlier messages did not load. Try again.';
const snapshotRows = (thread: Thread) => (thread.shape === 'rows' ? thread.items : thread.history);
type Scrolled = { nativeEvent?: { contentOffset?: { y?: number }; layoutMeasurement?: { height?: number } } };
/** Rows already on the phone that are not mounted yet: how many, and the way to mount a page of them; `holds` false: the list cannot keep the reader's place while rows join above (a sent message is pinned), so none are added. */
type Local = { hidden: number; reveal: () => void; holds?: boolean };

/**
 * `pageCache`, `pageKey`: where the rows above the snapshot are kept sealed between opens (null: nowhere, and the hook is what it was). Saved rows are a
 * first paint, never the truth: they are placed above the first snapshot only when its first row is one of them, and replaced by what the Mac says.
 */
export function useEarlier(request: Owned, chatId: string, pageCache: PageCache | null = null, pageKey: string | null | undefined = null) {
  const [rows, setRows] = useState<Data[]>([]);
  // null until a page says whether the chat goes back further
  const [more, setMore] = useState<boolean | null>(null);
  const [omitted, setOmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the rows above the snapshot as the last change set them (not as the last render drew them: a page that landed a moment ago is in it), for a read again to keep the ones it does not cover
  const held = useRef<Data[]>([]);
  const commit = useCallback((next: Data[]) => {
    held.current = next;
    setRows(next);
  }, []);
  const running = useRef(false);
  // the rows this chat was left with, read from the sealed copy, until a snapshot places them or they are found not to belong; and the snapshot they were placed for
  const seed = useRef<PageSnapshot | null>(null);
  const snapshot = useRef<Thread | null>(null);
  // when the rows held were last known to be the Mac's (read from it, or set against what it has): a saved copy ages from then, not from the save; and the generation of the sealed copies the chat was opened at
  const verified = useRef<number | undefined>(undefined);
  const generation = useRef<string | undefined>(undefined);
  // an ask that came while a page was on its way: the next scroll under the finger asks again
  const wanted = useRef(false);
  // the text held above the snapshot, whether the chat starts there, and the quiet fill's failures in a row and when it may ask again
  const bytes = useRef(0);
  const ended = useRef(false);
  const fails = useRef(0);
  const retryAt = useRef(0);
  // a finger on the list: one gesture asks for at most one page at the top. A scroll event with no finger behind it asks only from the distance ahead of the top, a few times in a row and not right after a page landed: a page that did not hold the reader's place would otherwise ask for the next, and the next, down to the start of the chat (#4734)
  const armed = useRef(false);
  // pages asked for in a row with no finger, and when the last page landed
  const chain = useRef(0);
  const landed = useRef(0);
  // rows that join above wait for the reader to rest
  const queue = useGestureQueue();
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
  /**
   * Asks for the page before the oldest row shown; one request at a time. `limit`: rows wanted, for a page asked for before the reader is at the
   * top. `quiet`: the background fill, which sets no busy and no error (the visible row is for a page the reader asked for); a failure only
   * delays the fill's next ask.
   */
  async function load(thread: Thread, limit?: number, quiet = false) {
    const before = cursor(thread);
    if (!before) return;
    if (running.current) {
      // a page is on its way: the reader's ask waits for it, and the row says so
      if (!quiet) {
        wanted.current = true;
        setBusy(true);
      }
      return;
    }
    const mine = era.current;
    running.current = true;
    if (!quiet) {
      setBusy(true);
      setError(null);
    }
    // the rows of this ask have joined (or it failed): the spinner goes then; a page the reader waited for ends it, the quiet fill never showed it
    const waited = () => !quiet || wanted.current;
    let joining = false;
    try {
      const page = await readEarlier(request, chatId, before, limit);
      if (mine !== era.current) return;
      landed.current = Date.now();
      const askedWhileWaiting = waited();
      // a row the phone holds already is not added twice
      const known = new Set([...held.current, ...snapshotRows(thread)].map((r) => str(r.id)).filter((id): id is string => !!id));
      const arrived = newRows(page.rows, known);
      // the cursor moves on when the page ARRIVES, not when it joins: a new drag at the top before the finger lifted asks for the page after this one, never this one again
      oldest.current = str(arrived[0]?.id) ?? oldest.current;
      bytes.current += arrived.reduce((n, r) => n + JSON.stringify(r).length, 0);
      ended.current = !page.more;
      // a page that says there is more but adds nothing would be asked for again as it is: a failure to retry, not the end of the chat
      if (page.more && arrived.length === 0) throw new Error(NO_PROGRESS);
      fails.current = 0;
      retryAt.current = 0;
      joining = true;
      queue.after(() => {
        // the chat may have been read again while the page waited for the reader to rest
        if (mine !== era.current) return;
        const shown = new Set([...held.current, ...snapshotRows(thread)].map((r) => str(r.id)).filter((id): id is string => !!id));
        commit([...newRows(page.rows, shown), ...held.current]);
        setMore(page.more);
        setOmitted(page.omitted);
        if (askedWhileWaiting) setBusy(false);
      });
    } catch (e) {
      if (mine === era.current) {
        if (!quiet) setError(explain(e));
        else retryAt.current = Date.now() + Math.min(backfill.retryMax, backfill.retry * 2 ** fails.current++);
      }
    } finally {
      if (mine === era.current) {
        running.current = false;
        // the reader's ask that waited is made again by the next scroll under the finger
        if (wanted.current) armed.current = true;
        // the spinner goes when the page's rows join (above); a failure ends it here
        if (!joining && waited()) setBusy(false);
        wanted.current = false;
      }
    }
  }
  const grab = () => {
    armed.current = true;
    chain.current = 0;
    queue.hold();
  };
  // the gesture is over: when the finger lifts with no momentum behind it, or when the list stops
  const release = () => {
    armed.current = false;
    queue.rest();
  };
  const scrolled = (thread: Thread, event: Scrolled, local?: Local) => {
    // rows joining above would move the reader: none are added while the list cannot hold the place
    if (local?.holds === false) return;
    const y = event.nativeEvent?.contentOffset?.y ?? Infinity;
    const view = event.nativeEvent?.layoutMeasurement?.height ?? 0;
    const atTop = armed.current && y <= NEAR_TOP;
    // the list's size is known, the reader is within a few screens of the top, the chain is short and no page has just landed
    const ahead =
      !atTop &&
      view > 0 &&
      y <= Math.max(AHEAD_MIN, view * AHEAD_SCREENS) &&
      chain.current < MAX_CHAIN &&
      Date.now() - landed.current > SETTLE_MS;
    if (!atTop && !ahead) return;
    // rows the phone holds but has not mounted come first; the computer is asked once they are all shown
    if (local?.hidden) {
      // rows the phone holds cost no request: a reveal ahead of the top spends none of the chain and leaves the gesture armed for the top (it is not asked for again until the screen drew it); only a finger at the top ends its one ask
      if (atTop) armed.current = false;
      landed.current = Date.now();
      // rows that join above wait for the reader to rest, as the pages do
      queue.after(local.reveal);
      return;
    }
    if (more === false || ended.current || error) return;
    armed.current = false;
    if (ahead) chain.current++;
    void load(thread, ahead ? AHEAD_PAGE : undefined);
  };
  // the newest load, so that the filling below does not change with every render
  const loader = useRef(load);
  loader.current = load;
  /**
   * Fills the rows above the snapshot in the background while the chat is open, a page every BACKFILL_GAP_MS, up to backfill.rows: called from an
   * effect, it returns what stops it (the chat left, another page landed, the chat read from its start). It is another function whenever what it
   * looks at changes, so the effect runs again then. It waits while a request is out or a finger is on the list, and stops at the start of the
   * chat, at the cap and after a failure. The rows are held in memory only, for this screen.
   */
  // whether this Mac pages from held rows: an older Mac reads the transcript for every page, so it is asked for a page only when the reader is near
  const { cheap, askAgain } = usePagesHeld(request);
  const probeAgain = useRef(askAgain);
  probeAgain.current = askAgain;
  const fillRows = useCallback(
    (thread: Thread | null) => {
      if (
        !cheap ||
        !thread ||
        busy ||
        more === false ||
        error ||
        rows.length >= backfill.rows ||
        bytes.current >= backfill.bytes ||
        fails.current >= FILL_RETRIES ||
        !(oldest.current ?? oldestId(thread))
      )
        return undefined;
      let alive = true;
      let timer: ReturnType<typeof setTimeout>;
      const tick = async () => {
        // read from the refs: a page that just landed has not been rendered yet, and the tick that was set before it must not ask again
        if (ended.current || fails.current >= FILL_RETRIES || held.current.length >= backfill.rows || bytes.current >= backfill.bytes)
          return;
        const now = Date.now();
        // a turn streaming, the app away, a finger on the list, a page on its way, or a failure not long ago: not now
        if (
          running.current ||
          armed.current ||
          inBackground() ||
          STREAMING.has(String(thread.session?.turnStatus)) ||
          now < retryAt.current
        ) {
          timer = setTimeout(tick, Math.max(backfill.gap, retryAt.current - now));
          return;
        }
        await loader.current(thread, BACKFILL_PAGE, true);
        // a page that landed changes what the effect looks at, which starts it again; a failure or a page on its way does not
        if (alive) timer = setTimeout(tick, backfill.gap);
      };
      timer = setTimeout(tick, backfill.gap);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    },
    [cheap, busy, more, error, rows.length],
  );
  // what the next save writes: the rows above the snapshot and the snapshot's own, once the Mac has answered; the last one wrote nothing smaller than what it replaces by being short
  const lastSave = useRef<() => void>(() => undefined);
  /** Runs in the chat's effect: saves the rows `backfill.save` ms after the last change, and starts the fill. Returns what stops both. */
  const fill = useCallback(
    (thread: Thread | null) => {
      const stopFill = fillRows(thread);
      if (!pageCache || !pageKey || !thread) return stopFill;
      const save = () => {
        const all = [...held.current, ...snapshotRows(thread)];
        if (all.length)
          void pageCache
            .save(pageKey, { rows: all, more: more !== false, epoch: thread.epoch, at: verified.current }, generation.current)
            .catch(() => undefined);
      };
      lastSave.current = save;
      const timer = setTimeout(save, backfill.save);
      return () => {
        clearTimeout(timer);
        stopFill?.();
      };
    },
    [fillRows, pageCache, pageKey, more],
  );
  // leaving the chat saves what it holds at once
  useEffect(() => {
    void pageKey; // another chat saves the one that was left
    return () => lastSave.current();
  }, [pageKey]);
  const reset = useCallback(() => {
    era.current++;
    running.current = false;
    queue.clear();
    armed.current = false;
    chain.current = 0;
    landed.current = 0;
    wanted.current = false;
    bytes.current = 0;
    ended.current = false;
    fails.current = 0;
    retryAt.current = 0;
    base.current = null;
    oldest.current = null;
    verified.current = undefined;
    commit([]);
    setMore(null);
    setOmitted(false);
    setError(null);
    setBusy(false);
  }, [commit, queue.clear]);
  // the saved rows just placed, and the row they end before: a page the Mac reads for that row is set against them once the Mac is known to page from held rows
  const against = useRef<{ before: string; rows: Data[] } | null>(null);
  const cheapNow = useRef(false);
  cheapNow.current = cheap;
  /** Drops this chat's saved copy, which does not belong; the screen's own later save of what the Mac showed still goes through. */
  const dropCopy = useCallback(() => {
    if (pageCache && pageKey) void pageCache.discard(pageKey).catch(() => undefined);
  }, [pageCache, pageKey]);
  // a check that could not be answered is tried again a few times, later each time
  const checkTries = useRef(0);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const again = useRef<() => void>(() => undefined);
  useEffect(() => () => clearTimeout(checkTimer.current), []);
  const runCheck = useCallback(() => {
    const check = against.current;
    if (!check || !cheapNow.current) return;
    against.current = null;
    const mine = era.current;
    readEarlier(request, chatId, check.before).then(
      (page) => {
        if (mine !== era.current) return;
        const n = Math.min(page.rows.length, check.rows.length);
        const saved = check.rows.slice(check.rows.length - n);
        const read = page.rows.slice(page.rows.length - n);
        if (n > 0 && saved.every((r, i) => str(r.id) === str(read[i]?.id) && r.role === read[i]?.role && r.text === read[i]?.text)) {
          verified.current = Date.now();
          return;
        }
        // the rows the Mac has just above the snapshot are not the saved ones (a compaction or a rewind): the saved rows go, and what was paged above them,
        // which hung from them. The Mac's own page takes their place, so what is above the snapshot is true and the reader's place below it does not move.
        const adopt = () => {
          if (mine !== era.current) return;
          // not under the reader's finger: a drag that is reading the rows about to go is not pulled out from under it, they go when the finger lifts
          if (armed.current) {
            checkTimer.current = setTimeout(adopt, 250);
            return;
          }
          // (a snapshot was placed on: the check is made only after one)
          const here = new Set(snapshotRows(snapshot.current as Thread).flatMap((r) => str(r.id) ?? []));
          const fresh = newRows(page.rows, here);
          era.current++;
          running.current = false;
          wanted.current = false;
          chain.current = 0;
          fails.current = 0;
          retryAt.current = 0;
          ended.current = !page.more;
          oldest.current = str(fresh[0]?.id) ?? null;
          bytes.current = fresh.reduce((sum, r) => sum + JSON.stringify(r).length, 0);
          verified.current = Date.now();
          commit(fresh);
          setMore(page.more);
          setBusy(false);
          dropCopy();
        };
        adopt();
      },
      () => {
        if (mine !== era.current || ++checkTries.current > FILL_RETRIES) return;
        against.current = check;
        checkTimer.current = setTimeout(() => again.current(), backfill.retry * checkTries.current);
      },
    );
  }, [request, chatId, commit, dropCopy]);
  again.current = runCheck;
  /** The saved rows placed above `next`, when its first row is one of them (same id, role and text) with rows before it; false when not. */
  const place = useCallback(
    (saved: PageSnapshot, next: Thread) => {
      // the first row of the Mac's history, whichever shape the snapshot has (a turn running sends its saved rows as `history`)
      const first = snapshotRows(next)[0];
      const id = str(first?.id);
      const at = id ? saved.rows.findIndex((r) => str(r.id) === id) : -1;
      const match = saved.rows[at];
      // the Mac's name for what the history started as must be the one it was saved under (a Mac that sends none matches a copy saved without one)
      if (!first || at <= 0 || match?.role !== first.role || match?.text !== first.text || saved.epoch !== next.epoch) return false;
      const kept = saved.rows.slice(0, at);
      oldest.current = str(kept[0]?.id);
      bytes.current = kept.reduce((n, r) => n + JSON.stringify(r).length, 0);
      commit(kept);
      setMore(saved.more);
      // the copy is as right as it was when it was last known to be: the Mac's epoch matching is knowing it now
      verified.current = saved.epoch !== undefined ? Date.now() : saved.at;
      checkTries.current = 0;
      // a page read from the Mac, set against the rows just placed (see `runCheck`)
      against.current = { before: id as string, rows: kept };
      runCheck();
      return true;
    },
    [commit, runCheck],
  );
  /** Places the saved rows, or drops them: a copy that does not belong above this snapshot is not kept to be tried again. */
  const settle = useCallback(
    (saved: PageSnapshot, next: Thread) => {
      if (place(saved, next)) return true;
      dropCopy();
      return false;
    },
    [place, dropCopy],
  );
  // the Mac turning out to page from held rows is when the placed rows are first set against what it has
  useEffect(() => {
    void cheap; // runCheck reads it through a ref; the Mac saying so is what runs the check
    runCheck();
  }, [cheap, runCheck]);
  // the sealed rows of this chat, read as it opens; a snapshot that came first is placed now, when the reader has paged to nothing yet
  useEffect(() => {
    seed.current = null;
    snapshot.current = null;
    generation.current = pageCache && pageKey ? pageCache.generation(pageKey) : undefined;
    if (!pageCache || !pageKey) return;
    let live = true;
    pageCache.load(pageKey).then(
      (saved) => {
        if (!live || !saved) return;
        if (!snapshot.current) seed.current = saved;
        else if (!held.current.length && !armed.current) settle(saved, snapshot.current);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pageCache, pageKey, settle]);
  const reread = useCallback(
    (previous: Thread | null, next: Thread) => {
      snapshot.current = next;
      // the Mac has answered: a fill that gave up while it was away, or is waiting out a long pause between tries, gets one more try now
      fails.current = Math.min(fails.current, FILL_RETRIES - 1);
      retryAt.current = 0;
      probeAgain.current();
      const saved = seed.current;
      seed.current = null;
      if (!previous && saved && settle(saved, next)) return;
      // the rows above the new snapshot: those paged back and those of the old snapshot it no longer reaches (the computer caps a read at 200 blocks)
      const kept = previous?.shape === 'rows' ? keptAbove([...held.current, ...previous.items], next) : null;
      if (!kept) return reset();
      oldest.current = str(kept[0]?.id);
      bytes.current = kept.reduce((n, r) => n + JSON.stringify(r).length, 0);
      // a prefix of the same rows with the same length is the same rows: nothing to redraw
      if (kept.length !== held.current.length) commit(kept);
    },
    [reset, commit, settle],
  );
  return {
    rows,
    more,
    omitted,
    error,
    busy,
    cursor,
    load,
    fill,
    /** An older row as the list draws it, worked out once for each row (a page landing does not work out the rows above it again). */
    item: earlierRow,
    /** What the row above the first message shows and does: held rows are mounted before the computer is asked. */
    row: (thread: Thread | null, local: Local) => ({
      more: more !== false || !!local.hidden,
      omitted,
      busy,
      error,
      load: () => {
        chain.current = 0;
        // the row is drawn only when there is a thread to page back from (Thread.tsx canPageBack), or rows to mount
        return local.hidden ? local.reveal() : void load(thread as Thread);
      },
    }),
    /** A finger went down on the list: the gesture may ask for one page. */
    grab,
    /** The reader let go (the finger lifted, the glide ended or fell silent): what waited for them joins. */
    release,
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
      // the rows that waited for the reader join when the follow hook says they let go (`release`, handed to it): a glide that ends under a finger put down on it is not that
      onScrollEndDrag: (event: { nativeEvent?: { velocity?: { y?: number } } }) => list.onScrollEndDrag(event),
      onMomentumScrollEnd: () => list.onMomentumScrollEnd(),
      onScroll: (event: E) => {
        list.onScroll(event);
        if (thread) scrolled(thread, event, local);
      },
    }),
    /** Forgets what was loaded, for a chat that was opened again. */
    reset,
    /** The chat was read again, or followed again with no snapshot before it (it was opened, or the computer was away): what was paged back above the new snapshot stays when it can be placed, and anything the snapshot covers or contradicts goes. */
    reread,
  };
}
