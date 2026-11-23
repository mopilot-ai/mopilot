// Motion bench renderer jank (#3810): long-task and long-animation-frame entries a PerformanceObserver collects in a MoPilot page over CDP while a computer-use turn runs, summarized over the turn.
import { quantile, round } from './stats.mjs';

/** A task over this many ms blocks the main thread (the Long Tasks API's own limit). */
export const LONG_TASK_MS = 50;

/** Page code that starts collecting `{ type, start (wall ms), duration, blocking }` entries into `window.__motionJank`; safe to run twice. */
export const JANK_INSTALL_JS = `(() => {
  if (window.__motionJank) return;
  const out = (window.__motionJank = []);
  for (const type of ['longtask', 'long-animation-frame']) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) out.push({ type, start: performance.timeOrigin + e.startTime, duration: e.duration, blocking: e.blockingDuration ?? null });
      }).observe({ type, buffered: true });
    } catch {
      // this Chromium has no such entry type
    }
  }
})()`;

/** Starts collecting in a Playwright page. */
export const installJank = (/** @type {{ evaluate: (code: string) => Promise<any> }} */ page) => page.evaluate(JANK_INSTALL_JS);
/** The entries collected so far. */
export const readJank = (/** @type {{ evaluate: (code: string) => Promise<any> }} */ page) => page.evaluate('window.__motionJank || []');

/**
 * Jank over a window (wall ms): long tasks and their blocking time (what each took over 50 ms), how many per minute, the
 * worst and the 95th percentile, and the long animation frames the same way.
 * @param {{ type: string, start: number, duration: number, blocking?: number | null }[]} entries @param {{ from: number, to: number }} window
 */
export function jankSummary(entries, { from, to }) {
  const inside = entries.filter((e) => e.start >= from && e.start <= to);
  const tasks = inside.filter((e) => e.type === 'longtask');
  const frames = inside.filter((e) => e.type === 'long-animation-frame');
  const minutes = (to - from) / 60000;
  const block = (/** @type {typeof inside} */ list) => list.reduce((s, e) => s + (e.blocking ?? Math.max(0, e.duration - LONG_TASK_MS)), 0);
  const durations = (/** @type {typeof inside} */ list) => list.map((e) => e.duration);
  return {
    windowMs: round(to - from),
    longTasks: tasks.length,
    longTasksPerMin: minutes > 0 ? round(tasks.length / minutes) : null,
    blockingMs: round(block(tasks)),
    worstMs: tasks.length ? round(Math.max(...durations(tasks))) : null,
    p95Ms: round(quantile(durations(tasks), 0.95)),
    loaf: { count: frames.length, blockingMs: round(block(frames)), worstMs: frames.length ? round(Math.max(...durations(frames))) : null },
  };
}
