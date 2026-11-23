// An off-by-default log of how the phone feels, for measuring on a device: JS-thread and UI-thread frames over 25 and 50 ms, JS stalls over 50 ms, how long from a touch to the first commit of an instrumented screen, and how many times each instrumented screen rendered. Counts and milliseconds only: never a title, a message or an id. It is on only after Settings › About turns it on, and off again at every launch.
import { useLayoutEffect } from 'react';
import { causesOf, ownerFiber } from './perfCause';

/** A frame at 60 Hz is 16.7 ms: over 25 ms one was missed, over 50 ms three. */
export const SLOW = 25;
export const STALL = 50;
/** The JS thread is sampled this often; a sample that arrives later than this by SLOW or STALL is a slow frame or a stall. */
const TICK = 16;
/** The report is also written to the console this often, for a log capture to read. */
const PRINT = 5_000;

export type Frames = { total: number; over25: number; over50: number };
export type PerfReport = {
  seconds: number;
  js: Frames;
  ui: Frames;
  /** JS stalls (a sample later than 50 ms): how many, and the longest in ms. */
  stalls: { count: number; worst: number };
  /** Finger down (the native touch time) to the first commit of an instrumented screen, per touch, in ms; `queue` is how much later than the fastest touch seen the JS thread got the touch (a busy JS thread). */
  touch: Spread & {
    /** Finger down to the second frame after it (the JS thread drew something), for every touch, whether or not it caused a commit. */
    frame: Spread;
    /** Touches that committed nothing within {@link WAIT_LIMIT} ms (a native-handled tap, such as focusing the field): not counted as slow commits. */
    noCommit: number;
    queue: Spread;
    /** The last touches' waits in order, so one interaction can be read on its own (the last {@link RECENT}). */
    recent: number[];
  };
  /** How many times each instrumented screen rendered. */
  renders: Record<string, number>;
  /** Per screen, how long a render took from its start to its commit (children included), in ms. */
  renderMs: Record<string, { mean: number; worst: number }>;
  /** With the trace on (development builds): per screen, why each render happened and how many times: the props or states that differed, or `no change`. */
  why: Record<string, Record<string, number>>;
  /** Counted events: `delta` (a live event reached the chat), `thread-update` (the chat screen was handed new rows). */
  events: Record<string, number>;
};
/** How many touches' waits the report keeps in order. */
export const RECENT = 20;
/** How many causes per screen the report keeps, the commonest first. */
export const WHY_KEPT = 12;
/** A touch whose commit comes later than this caused none: the next commit is some other work's. */
export const WAIT_LIMIT = 1000;
export type Spread = { count: number; median: number; worst: number };

export type Clock = {
  now: () => number;
  every: (fn: () => void, ms: number) => () => void;
  /** Runs `fn` once, at the next frame. */
  frame: (fn: () => void) => void;
  print: (line: string) => void;
};

/** The device's clock, its timers and its console. */
export const realClock: Clock = {
  now: () => performance.now(),
  every: (fn, ms) => {
    const id = setInterval(fn, ms) as unknown as { unref?: () => void };
    id.unref?.();
    return () => clearInterval(id as unknown as number);
  },
  frame: (fn) => void requestAnimationFrame(fn),
  print: (line) => console.log(line),
};

const frames = (): Frames => ({ total: 0, over25: 0, over50: 0 });
const bucket = (f: Frames, ms: number) => {
  f.total += 1;
  if (ms > SLOW) f.over25 += 1;
  if (ms > STALL) f.over50 += 1;
};

export function createPerfLog(clock: Clock = realClock) {
  let on = false;
  let began = 0;
  let last = 0;
  let touchedAt: number | null = null;
  let tracing = false;
  /** The least (JS now minus native touch time) seen: the clocks' offset plus the fastest hand-over; any more is the JS thread being late. */
  let floor: number | null = null;
  let stop: (() => void)[] = [];
  let data = fresh();
  const listeners = new Set<() => void>();
  function fresh() {
    return {
      js: frames(),
      ui: frames(),
      stalls: { count: 0, worst: 0 },
      touches: [] as number[],
      queue: [] as number[],
      frames: [] as number[],
      noCommit: 0,
      renders: {} as Record<string, number>,
      renderTime: {} as Record<string, { n: number; sum: number; worst: number }>,
      events: {} as Record<string, number>,
      why: {} as Record<string, Record<string, number>>,
    };
  }
  const tell = () => listeners.forEach((l) => l());
  const spread = (values: number[]): Spread => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? 0, worst: sorted.at(-1) ?? 0 };
  };
  const report = (): PerfReport => {
    return {
      seconds: Math.round((clock.now() - began) / 1000),
      js: { ...data.js },
      ui: { ...data.ui },
      stalls: { ...data.stalls },
      touch: {
        ...spread(data.touches),
        queue: spread(data.queue),
        frame: spread(data.frames),
        noCommit: data.noCommit,
        recent: data.touches.slice(-RECENT),
      },
      renders: { ...data.renders },
      renderMs: Object.fromEntries(
        Object.entries(data.renderTime).map(([name, t]) => [name, { mean: Math.round(t.sum / t.n), worst: Math.round(t.worst) }]),
      ),
      events: { ...data.events },
      why: Object.fromEntries(
        Object.entries(data.why).map(([name, causes]) => [
          name,
          Object.fromEntries(
            Object.entries(causes)
              .sort((x, y) => y[1] - x[1])
              .slice(0, WHY_KEPT),
          ),
        ]),
      ),
    };
  };
  return {
    get enabled() {
      return on;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    report,
    start() {
      if (on) return;
      on = true;
      data = fresh();
      began = last = clock.now();
      touchedAt = null;
      floor = null;
      stop = [
        clock.every(() => {
          // how late this sample is, over the one frame it should take
          const t = clock.now();
          const late = Math.max(0, t - last - TICK);
          last = t;
          bucket(data.js, late + TICK);
          if (late + TICK > STALL) {
            data.stalls.count += 1;
            data.stalls.worst = Math.max(data.stalls.worst, Math.round(late + TICK));
          }
        }, TICK),
        clock.every(() => clock.print(`[perf] ${JSON.stringify(report())}`), PRINT),
      ];
      tell();
    },
    end() {
      if (!on) return;
      on = false;
      tracing = false;
      for (const s of stop) s();
      stop = [];
      tell();
    },
    /** Zeroes the numbers and keeps recording. */
    reset() {
      data = fresh();
      began = last = clock.now();
      tell();
    },
    /** A finger went down; `nativeTime` is when the system saw it (the touch event's timestamp), so a JS thread that was busy is counted, not hidden. */
    touch(nativeTime?: number) {
      if (!on) return;
      const at = clock.now();
      let late = 0;
      if (typeof nativeTime === 'number' && Number.isFinite(nativeTime)) {
        const gap = at - nativeTime;
        floor = floor === null ? gap : Math.min(floor, gap);
        late = Math.round(gap - floor);
        data.queue.push(late);
      }
      // a touch that never committed anything is counted, not left to be answered by some later commit
      if (touchedAt !== null) data.noCommit += 1;
      const begun = (touchedAt = at - late);
      // the second frame after the touch: the JS thread had drawn something by then, commit or not
      clock.frame(() => clock.frame(() => on && data.frames.push(Math.round(clock.now() - begun))));
    },
    /** An instrumented screen committed: the first one after a touch ends that touch's wait; `name` and `began` (what `render` returned) time that screen's own render. */
    committed(name?: string, began?: number) {
      if (!on) return;
      if (name !== undefined && began !== undefined && began >= 0) {
        const took = clock.now() - began;
        const t = (data.renderTime[name] ??= { n: 0, sum: 0, worst: 0 });
        t.n += 1;
        t.sum += took;
        t.worst = Math.max(t.worst, took);
      }
      if (touchedAt === null) return;
      const waited = Math.round(clock.now() - touchedAt);
      touchedAt = null;
      // a commit this long after the touch is another piece of work's: the touch itself caused none
      if (waited > WAIT_LIMIT) data.noCommit += 1;
      else data.touches.push(waited);
    },
    /** One render of an instrumented screen; returns when it began, or -1 while the log is off. */
    render(name: string) {
      if (!on) return -1;
      data.renders[name] = (data.renders[name] ?? 0) + 1;
      return clock.now();
    },
    /** Whether renders are traced (see `usePerfRender`); the trace only reads React's bookkeeping in development builds. */
    get tracing() {
      return tracing;
    },
    trace(value: boolean) {
      tracing = value && on;
      tell();
    },
    /** One render of `name` and the reasons it happened. */
    cause(name: string, reasons: string[]) {
      if (!on || !tracing) return;
      const mine = (data.why[name] ??= {});
      for (const reason of reasons) mine[reason] = (mine[reason] ?? 0) + 1;
    },
    /** Counts something that happened, by name. */
    event(name: string) {
      if (on) data.events[name] = (data.events[name] ?? 0) + 1;
    },
    /** UI-thread frames counted since the last call (the probe sums them on that thread and hands them over in batches). */
    uiFrames(batch: Frames) {
      if (!on) return;
      data.ui.total += batch.total;
      data.ui.over25 += batch.over25;
      data.ui.over50 += batch.over50;
    },
  };
}

export const perf = createPerfLog();

/** Counts the render of the screen that calls it and notes its commit; costs one check while the log is off. */
export function usePerfRender(name: string) {
  const began = perf.render(name);
  // while tracing, the fibre that is rendering now: read at its commit, when it can be compared with the one before
  const fiber = perf.tracing ? ownerFiber() : null;
  // a layout effect runs when the screen and everything under it has been committed
  useLayoutEffect(() => {
    perf.committed(name, began);
    if (perf.tracing) perf.cause(name, causesOf(fiber));
  });
}
