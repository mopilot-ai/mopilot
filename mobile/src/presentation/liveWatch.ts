// A safety net under a followed chat's live events: while the chat is open and no live event arrives, it is read again (backing off: fast while a turn runs, slow when idle), once just after a turn ends, and once on returning to the front; the re-reads that brought rows the live feed never delivered are counted, so a device shows whether the net is doing the work.
import { perf } from '../perfLog';

/** How long a running turn may be quiet before the first re-read. */
export const QUIET_MS = 4000;
/** The wait before each re-read while the chat stays quiet and a turn runs: the last one repeats. */
export const BACKOFF_MS = [4000, 8000, 16000, 30000];
/** The same while the chat is open and idle (the heartbeat: it finds a short turn whose live events never came). The chat list is no help here: its changes arrive as `chats.changed` live events on the same stream (see awayEvents.cjs), so they drop with the rest. */
export const IDLE_MS = [8000, 12000, 20000];
/** The first looks after a message was sent from this phone or the app came back to the front: a reply is expected. */
export const EXPECT_MS = [3000, 6000, 10000];
/** How long after a turn is seen to end the chat is read once more, for the rows that closed it. */
export const END_MS = 1500;

/** Per app run: re-reads that brought rows the live events had not (`missed`), and re-reads that brought nothing (`quiet`). */
export type LiveNetCounts = { missed: number; quiet: number };
const counts: LiveNetCounts = { missed: 0, quiet: 0 };
const listeners = new Set<() => void>();
let frozen: LiveNetCounts = { ...counts };
export const liveNetCounts = (): LiveNetCounts => frozen;
export function onLiveNetCounts(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function count(kind: keyof LiveNetCounts) {
  counts[kind] += 1;
  frozen = { ...counts };
  perf.event(kind === 'missed' ? 'live-missed' : 'net-reread');
  listeners.forEach((l) => l());
}

/** Watches that are on, told when a message leaves this phone. */
const expecters = new Map<string, Set<() => void>>();
/** A message was sent from this phone in a chat: a reply is expected, so that chat is looked at sooner. */
export const expectReply = (key: string) => expecters.get(key)?.forEach((boost) => boost());

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };

/** What the feed passes the net: the foreground signal (the device's, so tests need none) and, for tests, the clock. */
export type WatchOptions = {
  /** Names the chat, so a message sent in it boosts its own watch and not another open screen's. */
  key?: string;
  foreground?: (fn: () => void) => () => void;
  now?: () => number;
  /** False while the app is in the background: the heartbeat reads nothing then. */
  visible?: () => boolean;
};

/**
 * @param running whether the followed chat's turn is running now
 * @param signature the chat's revision and feed position
 * @param size how many rows the chat holds: a re-read that brought more than it had also found what the live feed never sent
 * @param reread asks the feed for a quiet re-read; false when none was started (one is already out, or nothing is shown yet)
 */
export function createLiveWatch(o: {
  running: () => boolean;
  signature: () => string;
  size: () => number;
  reread: () => boolean;
  timers: Timers;
  options: WatchOptions;
}) {
  const now = o.options.now ?? Date.now;
  let active = false;
  let timer: unknown = null;
  /** When the timer on the wire fires, and when the next re-read is due (an event moves the second, not the first). */
  let armedFor = 0;
  let dueAt = 0;
  let step = 0;
  /** Whether a turn ran at the last look: a change between looks is a turn that began or ended. */
  let wasRunning: boolean | null = null;
  const visible = o.options.visible ?? (() => true);
  let boosted = false;
  let slow = 1;
  const table = () => (o.running() ? BACKOFF_MS : boosted ? EXPECT_MS : IDLE_MS);
  /** The signature before the re-read on the wire; null when none is out. */
  let before: string | null = null;
  let sizeBefore = 0;
  let eventDuring = false;
  let off: (() => void) | null = null;

  const arm = (ms: number) => {
    armedFor = now() + ms;
    timer = o.timers.set(() => {
      timer = null;
      fire();
    }, ms);
    // a net still watching must not keep a process alive (React Native timers have no unref)
    (timer as { unref?: () => void } | null)?.unref?.();
  };
  const ask = () => {
    if (before !== null) return; // one at a time
    before = o.signature();
    sizeBefore = o.size();
    eventDuring = false;
    // a read that was not the net's own (one already out) is nobody's credit
    if (!o.reread()) before = null;
  };
  /** The live feed is (or just proved to be) working: the first step again. */
  const reset = () => {
    step = 0;
    const first = table()[0]!;
    dueAt = now() + first;
    // a timer set for a later backoff step would fire late
    if (timer !== null && armedFor > dueAt) {
      o.timers.clear(timer);
      arm(first);
    }
  };
  /** A reply is expected: look again soon, then at the heartbeat's pace. */
  const boost = () => {
    if (!active) return;
    boosted = true;
    step = 0;
    dueAt = now() + EXPECT_MS[0]!;
    if (timer !== null) o.timers.clear(timer);
    arm(EXPECT_MS[0]!);
  };
  function fire() {
    const left = dueAt - now();
    if (left > 0) return arm(left); // an event moved the due time on
    if (visible()) ask();
    step += 1;
    if (boosted && step >= EXPECT_MS.length) {
      boosted = false; // the expected moments are over: the heartbeat's own pace from its first wait
      step = 0;
    }
    const steps = table();
    // a link that failed a read is asked less often, up to 8 times as slowly, until a read gets through
    const wait = steps[Math.min(step, steps.length - 1)]! * slow;
    dueAt = now() + wait;
    arm(wait);
  }
  const sync = () => {
    const going = o.running();
    if (timer === null) {
      wasRunning = going;
      step = 0;
      dueAt = now() + table()[0]!;
      arm(dueAt - now());
    } else if (going !== wasRunning) {
      wasRunning = going;
      // a turn began: the quick backoff; a turn ended: one read soon, then the slow heartbeat (step -1 makes the one after it the first idle wait)
      step = going ? 0 : -1;
      dueAt = now() + (going ? QUIET_MS : END_MS);
      o.timers.clear(timer);
      arm(dueAt - now());
    }
  };
  return {
    /** The feed started: the net watches, and re-reads once on every return to the front. */
    start() {
      off?.();
      active = true;
      before = null;
      off =
        o.options.foreground?.(() => {
          ask();
          boost();
        }) ?? null;
      if (o.options.key !== undefined) {
        const set = expecters.get(o.options.key) ?? new Set<() => void>();
        set.add(boost);
        expecters.set(o.options.key, set);
      }
    },
    /** A live event for the chat arrived. */
    event() {
      if (!active) return;
      eventDuring = true;
      boosted = false; // the live feed is working
      reset();
    },
    /** The feed showed rows (after a read): counts what the net's own re-read brought, and sets the pace for what the chat is doing. */
    shown() {
      if (!active) return;
      slow = 1; // a read got through
      if (before !== null) {
        const brought = !eventDuring && (o.signature() !== before || o.size() > sizeBefore);
        before = null;
        if (brought) {
          count('missed');
          reset();
        } else if (!eventDuring) count('quiet');
      }
      sync();
    },
    /** A read failed: the net's re-read on the wire, if it was one, is over. */
    failed() {
      before = null;
      slow = Math.min(slow * 2, 8);
    },
    stop() {
      active = false;
      before = null;
      if (timer !== null) o.timers.clear(timer);
      timer = null;
      off?.();
      off = null;
      boosted = false;
      if (o.options.key !== undefined) expecters.get(o.options.key)?.delete(boost);
    },
  };
}
