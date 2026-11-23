// The shared fake of the main process's clock port (electron/platform/ports/clock.cjs, docs/architecture/modularization.md
// §3): time stands still until the test moves it, and a timer runs only when `advance` passes its time.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installClock } = require('../../../electron/platform/ports/clock.cjs');

type Timer = { at: number; fn: (...a: any[]) => void; args: any[]; every: number | null };

/** A timer handle the way Node's looks to the code holding it: it can be unref'd and cleared. */
const handle = (id: number) => ({ id, unref: () => handle(id), ref: () => handle(id), hasRef: () => true, [Symbol.toPrimitive]: () => id });

/** A clock at `start` (ms) whose timers run, in time order, only as `advance` moves past them. */
export function fakeClock(start = 0) {
  let time = start;
  let next = 1;
  const timers = new Map<number, Timer>();
  const add = (fn: (...a: any[]) => void, ms: number | undefined, args: any[], every: boolean) => {
    const id = next++;
    const delay = Math.max(0, ms ?? 0);
    timers.set(id, { at: time + delay, fn, args, every: every ? Math.max(1, delay) : null });
    return handle(id);
  };
  const clear = (h: unknown) => {
    timers.delete(typeof h === 'number' ? h : ((h as { id?: number } | null)?.id ?? -1));
  };
  return {
    now: () => time,
    setTimeout: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => add(fn, ms, args, false),
    clearTimeout: clear,
    setInterval: (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => add(fn, ms, args, true),
    clearInterval: clear,
    /** The timers still waiting. */
    get pending() {
      return timers.size;
    },
    /** Move time on by `ms`, running each timer whose time comes, earliest first (one set by a timer included). */
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        let due: [number, Timer] | null = null;
        for (const entry of timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, timer] = due;
        time = timer.at;
        if (timer.every === null) timers.delete(id);
        else timer.at += timer.every;
        timer.fn(...timer.args);
      }
      time = end;
    },
  };
}

/** Install a fake clock at `start` behind the clock port for the test, and put the global one back after it. */
export function useFakeClock(t: { after: (fn: () => void) => void }, start = 0) {
  const clock = fakeClock(start);
  const previous = installClock(clock);
  t.after(() => installClock(previous));
  return clock;
}

/** The clock port's module with timers that never run, for a test that loads a module's source with inert timers. */
export const inertClockPort = {
  clock: {
    now: () => Date.now(),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  },
};
