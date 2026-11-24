// The window's side of the always-on renderer record (electron/perf/rendererLog.cjs): a task that held the window for 200 ms or more, an input event that took 250 ms or more to show its result, and what the composer notes (src/lib/rendererNote.ts), each with the window's size and where it was (counts and the route's name), so a report that the app lagged or that keys did nothing can be read after the fact. Content-free, and at most 20 lines a minute.
import { observeLongTasks, observeSlowEvents } from './perf';
import { setRendererSink, type RendererRecord } from '../lib/rendererNote';

/** A task this long is worth a line. */
export const LONG_TASK_MS = 200;
/** An input event this slow (input delay, handlers and the frame that shows the result) is worth a line. */
export const SLOW_INPUT_MS = 250;
/** Slow input events within this long of a line sent are counted into the next one, not sent. */
export const SLOW_INPUT_GROUP_MS = 1000;
/** Lines a window sends per minute; the rest are not sent (main also keeps its own limit). */
export const LINES_PER_MINUTE = 20;

type Native = { perf: { record(line: Record<string, unknown>): void } };
type Store = { getState(): { route?: { name?: string } } };

/** Records in this window until the returned stop; `win` is for tests. */
export function installRendererRecord(native: Native, store: Store, win: Window = window): () => void {
  const observer = (win as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  let minute = -1;
  let sent = 0;
  const send = (line: RendererRecord) => {
    const at = Math.floor(win.performance.now() / 60_000);
    if (at !== minute) {
      minute = at;
      sent = 0;
    }
    if (sent >= LINES_PER_MINUTE) return;
    sent += 1;
    const doc = win.document;
    native.perf.record({
      ...line,
      route: store.getState().route?.name,
      rows: doc.querySelectorAll('[data-sidebar-chat]').length,
      messages: doc.querySelectorAll('.user-message').length,
      focused: doc.hasFocus(),
      visible: doc.visibilityState === 'visible',
    });
  };
  setRendererSink(send);
  const stopTasks = observeLongTasks((ms) => {
    if (ms >= LONG_TASK_MS) send({ what: 'longtask', ms: Math.round(ms) });
  }, observer);
  // one long task delays every event queued behind it (a pointerenter per row, a keydown per key): one line a second, with how many it stands for
  let lastInput = Number.NEGATIVE_INFINITY;
  let folded = 0;
  const stopEvents = observeSlowEvents((e) => {
    if (e.ms < SLOW_INPUT_MS) return;
    const at = win.performance.now();
    if (at - lastInput < SLOW_INPUT_GROUP_MS) {
      folded += 1;
      return;
    }
    lastInput = at;
    send({ what: 'slowInput', name: e.name, ms: e.ms, delay: e.delay, processing: e.processing, ...(folded ? { count: folded + 1 } : {}) });
    folded = 0;
  }, observer);
  return () => {
    stopTasks?.();
    stopEvents?.();
    setRendererSink(null);
  };
}
