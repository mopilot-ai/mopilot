// A followed chat's rows kept current without the person asking: the snapshot, the live events after it, and a quiet re-read when the live feed cannot be trusted (an event outside the live turn, a gap, a read that overflowed), one at a time and the newest wins.
import { catchingUp } from '../catchUp';
import { snapshot, update, type Data, type Thread } from './thread';
import { perf } from '../perfLog';
import { createLiveWatch, type WatchOptions } from './liveWatch';

/** Events held while a read is on the wire: more than this, or this many bytes, and the read is made again. */
const MAX_PENDING = 1000;
const MAX_PENDING_BYTES = 1_000_000;
/** A quiet re-read waits this long after the first reason for it, so a burst of events costs one read. */
export const RESYNC_MS = 300;
/** After a failed quiet re-read: 1 s, 2 s, 4 s; then the person is told. */
export const RETRY_MS = [1000, 2000, 4000];
/** What a person is told when every quiet re-read failed. */
export const QUIET_FAILURE = "Couldn't update this chat.";
/** While the app catches up (see catchUp.ts) the events that piled up are applied at once but shown at most this often, so catching up costs a few renders, not one per event. */
export const CATCH_UP_FLUSH_MS = 250;
/** A live event shows at once, and the events right after it (a stream's words) are shown together at the end of this window, so the screen renders at most once a frame, not once per event. */
export const FRAME_MS = 16;

export type FollowFeed = {
  /** Reads the chat and follows its events; the first thread (or the failure to get one) is reported through `on`. */
  start(): void;
  /** Stops following: nothing more is reported, a read on the wire is dropped. */
  stop(): void;
  /** Reads the chat again now, keeping what is shown (the person's own Refresh, or a reason the feed gave). */
  refresh(): void;
};

/** The turn states in which the chat is being worked on (what the net watches). */
const RUNNING = new Set(['running', 'inProgress', 'awaitingUser']);

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };

/**
 * @param read the follow request; its reply is a snapshot
 * @param subscribe the runtime's events for this chat (an event for another chat is not passed)
 * @param on `thread`: what to show now; `failed`: a read that could not be had (`quiet`: the rows on screen are kept)
 */
export function createFollowFeed(o: {
  read: () => Promise<unknown>;
  subscribe: (handle: (event: Data) => void) => () => void;
  on: { thread: (thread: Thread, reread: boolean) => void; failed: (message: string, quiet: boolean) => void };
  /** The chat the snapshot names, for a feed that does not know it in advance (MoMo's): events of any other chat are dropped. */
  accepts?: (event: Data, snap: Thread) => boolean;
  timers?: Timers;
  /** Opts into the safety net under the live events (see liveWatch.ts); a chat whose live events never come is read again while its turn runs. */
  watch?: WatchOptions;
}): FollowFeed {
  const timers: Timers = o.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  let current: Thread | null = null;
  let off: (() => void) | null = null;
  let generation = 0;
  let reading = false;
  let again = false;
  let timer: unknown = null;
  let failures = 0;
  let pending: Data[] = [];
  let pendingBytes = 0;
  let stopped = true;
  let flush: unknown = null;
  /** The frame window a live event opened, and whether events came during it that are not shown yet. */
  let frame: unknown = null;
  let dirty = false;
  const watch = o.watch
    ? createLiveWatch({
        running: () => RUNNING.has(String(current?.session.turnStatus)),
        signature: () => (current ? `${current.rev}:${current.feedSeq}` : ''),
        size: () => (current ? current.history.length + current.items.length : 0),
        reread: () => net.netRead(),
        timers,
        options: o.watch,
      })
    : null;

  // every show of rows to the screen counts as a thread update, live or not (the perf log compares them with the events that came in)
  const show = (thread: Thread, reread: boolean) => {
    perf.event('thread-update');
    o.on.thread(thread, reread);
  };
  const emit = (thread: Thread, reread: boolean) => {
    // the feed owns "stale": a snapshot or a re-read is the cure, so what is shown never carries it
    current = { ...thread, historyStale: false };
    if (flush !== null) timers.clear(flush);
    flush = null;
    if (frame !== null) timers.clear(frame);
    frame = null;
    dirty = false;
    show(current, reread);
    watch?.shown();
  };
  // shows the feed's rows now and keeps the window shut for a frame: what comes in it is shown once, when it ends
  const showLive = () => {
    show(current!, false);
    frame = timers.set(() => {
      frame = null;
      if (!dirty) return;
      dirty = false;
      showLive();
    }, FRAME_MS);
  };
  // while catching up after the app was away, a live event changes what the feed holds at once and what is shown a little later
  const emitLive = (thread: Thread) => {
    current = { ...thread, historyStale: false };
    if (!catchingUp()) {
      if (flush !== null) timers.clear(flush);
      flush = null;
      if (frame !== null) dirty = true;
      else showLive();
      return;
    }
    if (flush !== null) return;
    flush = timers.set(() => {
      flush = null;
      show(current!, false);
    }, CATCH_UP_FLUSH_MS);
  };
  const schedule = (ms: number) => {
    // (events during a read are held, not scheduled, and a read never starts while another is out)
    if (timer !== null) return;
    timer = timers.set(() => {
      timer = null;
      void load(true);
    }, ms);
  };
  const retryOrGiveUp = () => {
    failures += 1;
    if (failures > RETRY_MS.length) {
      failures = 0;
      o.on.failed(QUIET_FAILURE, true);
      return;
    }
    schedule(RETRY_MS[failures - 1]!);
  };
  async function load(quiet: boolean) {
    const mine = ++generation;
    reading = true;
    again = false;
    pending = [];
    pendingBytes = 0;
    try {
      const value = await o.read();
      if (stopped || mine !== generation) return;
      // what the snapshot says of its own staleness is the Mac's view at that moment; only an event after it counts here
      let thread = { ...snapshot(value), historyStale: false };
      // a quiet re-read that comes back with no rows at all never blanks a chat that shows some (a side chat the computer lost, a ring that emptied): the rows stay, the session and revision are the answer's
      if (quiet && current !== null && !thread.items.length && !thread.history.length && (current.items.length || current.history.length))
        thread = { ...thread, items: current.items, history: current.history, shape: current.shape };
      for (const event of pending) {
        if (o.accepts && !o.accepts(event, thread)) continue;
        try {
          thread = update(thread, event);
        } catch {
          // an event this phone cannot read: the snapshot after it is the answer, read again once this one is shown
          again = true;
        }
      }
      // an event outside the live turn that came while this read was out is one the snapshot may not hold
      if (thread.historyStale) again = true;
      reading = false;
      failures = 0;
      emit(thread, quiet);
      if (again) schedule(RESYNC_MS);
    } catch (e) {
      if (stopped || mine !== generation) return;
      reading = false;
      watch?.failed();
      const message = e instanceof Error ? e.message : String(e);
      // the first read has nothing to keep: it says why; a quiet one retries and, after the last try, says so
      if (!quiet && current === null) o.on.failed(message, false);
      else retryOrGiveUp();
    } finally {
      if (mine === generation) pending = [];
    }
  }
  const handle = (event: Data) => {
    if (stopped) return;
    perf.event('delta');
    watch?.event();
    if (reading || current === null) {
      pendingBytes += JSON.stringify(event).length;
      if (pending.length >= MAX_PENDING || pendingBytes > MAX_PENDING_BYTES) {
        // too much to hold while the read is out: read again once it is back, from a newer snapshot
        pending = [];
        pendingBytes = 0;
        again = true;
        return;
      }
      pending.push(event);
      return;
    }
    if (o.accepts && !o.accepts(event, current)) return;
    let next: Thread;
    try {
      next = update(current, event);
    } catch {
      // an event this phone cannot read (a Mac that is newer or older): the rows are read again instead
      schedule(RESYNC_MS);
      return;
    }
    const stale = next.historyStale;
    if (next !== current) emitLive(next);
    if (stale) schedule(RESYNC_MS);
  };
  const net: FollowFeed & { netRead(): boolean } = {
    start() {
      stopped = false;
      current = null;
      reading = false;
      again = false;
      failures = 0;
      off = o.subscribe(handle);
      watch?.start();
      void load(false);
    },
    stop() {
      stopped = true;
      generation += 1;
      if (timer !== null) timers.clear(timer);
      timer = null;
      if (flush !== null) timers.clear(flush);
      flush = null;
      if (frame !== null) timers.clear(frame);
      frame = null;
      dirty = false;
      off?.();
      off = null;
      watch?.stop();
    },
    /** The net's own read: not the person's Refresh, so it does not wipe the failures counted or the retry on its way. True when it started a read (one already out answers instead, and then asks once more). */
    netRead() {
      if (stopped || current === null) return false;
      if (reading) {
        again = true;
        return false;
      }
      void load(true);
      return true;
    },
    refresh() {
      if (stopped) return;
      failures = 0;
      if (timer !== null) timers.clear(timer);
      timer = null;
      if (reading) again = true;
      else void load(true);
    },
  };
  return net;
}
