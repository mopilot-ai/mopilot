// Motion bench metrics over a recording's regions: time to first visual feedback, animation runs with their duration and fitted curve, reveal cadence, dead air, dropped frames and layout shift.
import { bestShift, changeSeries, profile } from './frames.mjs';
import { fitBezier, nearest, progress } from './fit.mjs';

/** @typedef {import('./frames.mjs').Video} Video */
/** @typedef {import('./frames.mjs').Rect} Rect */
/** @typedef {import('./frames.mjs').Sample} Sample */
/** @typedef {{ start: number, end: number, from: number, to: number }} Run times in ms; frame indexes of the last still frame and the last changed one */

/**
 * A frame changed when the mass of its change (luma levels summed over the source px² that moved past PIXEL_DELTA)
 * reaches this: 64 px² moving by 64 levels. A mass, not a mean, so a word appearing in a large region counts as much
 * as in a small one (about 200k), while video keyframe artifacts (about 1.5k) do not.
 */
export const MIN_MASS = 4096;
/** An eased tail still moves while the mean luma changes by this much per frame, though no cell passes PIXEL_DELTA. */
export const SETTLE_D = 0.1;
/** One display refresh at 60 Hz, in ms. */
export const REFRESH_MS = 1000 / 60;

const changed = (/** @type {Sample} */ s, /** @type {number} */ mass) => s.m >= mass;

/**
 * Runs of change: changed frames merged across still gaps up to `mergeMs`. A run starts at its last still frame
 * (the motion began between frames) and ends at its last changed frame.
 * @param {Sample[]} series @param {{ minMass?: number, mergeMs?: number }} [o]
 * @returns {Run[]}
 */
export function runs(series, { minMass = MIN_MASS, mergeMs = 120 } = {}) {
  /** @type {Run[]} */
  const out = [];
  for (let i = 1; i < series.length; i += 1) {
    if (!changed(series[i], minMass)) continue;
    const last = out[out.length - 1];
    if (last && series[i].t - last.end <= mergeMs) {
      last.end = series[i].t;
      last.to = i;
    } else out.push({ start: series[i - 1].t, end: series[i].t, from: i - 1, to: i });
  }
  return out;
}

/**
 * A run widened through the small changes an eased start and tail make (no cell past PIXEL_DELTA, the mean still
 * moving by SETTLE_D each frame): back to where the motion began and on to where the region held still.
 * @param {Sample[]} series @param {Run} run
 * @returns {Run}
 */
export function settle(series, run, mergeMs = 120) {
  const moving = (/** @type {number} */ i, /** @type {number} */ near) =>
    series[i].d >= SETTLE_D && Math.abs(series[i].t - series[near].t) <= mergeMs;
  let from = run.from;
  while (from > 0 && moving(from, from + 1)) from -= 1;
  let to = run.to;
  while (to + 1 < series.length && moving(to + 1, to)) to += 1;
  return { from, to, start: series[from].t, end: series[to].t };
}

/** The time of the first changed frame at or after `from` ms, or null. */
export function firstChange(/** @type {Sample[]} */ series, from = Number.NEGATIVE_INFINITY, minMass = MIN_MASS) {
  return series.find((s, i) => i > 0 && s.t >= from && changed(s, minMass))?.t ?? null;
}

/**
 * Time from a trigger to the first visible response: the trigger is a time in ms (the driver's input) or the first
 * change in its own region at or after `after` ms (a click ripple, the composer clearing on send, not a caret blinking
 * before it); the response is the first change after it in the response region.
 * @param {Video} video @param {{ trigger: number | Rect, response: Rect, after?: number, minMass?: number }} o
 */
export function feedback(video, { trigger, response, after = Number.NEGATIVE_INFINITY, minMass = MIN_MASS }) {
  const at = typeof trigger === 'number' ? trigger : firstChange(changeSeries(video, trigger), after, minMass);
  if (at === null) return { trigger: null, response: null, ms: null };
  const seen = firstChange(changeSeries(video, response), at, minMass);
  return { trigger: Math.round(at), response: seen === null ? null : Math.round(seen), ms: seen === null ? null : Math.round(seen - at) };
}

/** Still stretches over `limitMs` between `from` and `to` ms: no visible progress for that long. */
export function deadAir(
  /** @type {Sample[]} */ series,
  /** @type {number} */ from,
  /** @type {number} */ to,
  limitMs = 1000,
  minMass = MIN_MASS,
) {
  const changes = [from, ...series.filter((s, i) => i > 0 && changed(s, minMass) && s.t > from && s.t < to).map((s) => s.t), to];
  /** @type {{ from: number, to: number, ms: number }[]} */
  const gaps = [];
  let longest = 0;
  for (let i = 1; i < changes.length; i += 1) {
    const ms = changes[i] - changes[i - 1];
    longest = Math.max(longest, ms);
    if (ms > limitMs) gaps.push({ from: Math.round(changes[i - 1]), to: Math.round(changes[i]), ms: Math.round(ms) });
  }
  return { longestMs: Math.round(longest), gaps };
}

const quantile = (/** @type {number[]} */ sorted, /** @type {number} */ q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** How a reveal updates: the number of visible updates, their intervals and their rate, over `from`–`to` ms. */
export function cadence(
  /** @type {Sample[]} */ series,
  from = Number.NEGATIVE_INFINITY,
  to = Number.POSITIVE_INFINITY,
  minMass = MIN_MASS,
) {
  const times = series.filter((s, i) => i > 0 && changed(s, minMass) && s.t >= from && s.t <= to).map((s) => s.t);
  const intervals = times
    .slice(1)
    .map((t, i) => t - times[i])
    .sort((a, b) => a - b);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  return {
    updates: times.length,
    medianMs: intervals.length ? Math.round(quantile(intervals, 0.5)) : null,
    p90Ms: intervals.length ? Math.round(quantile(intervals, 0.9)) : null,
    maxMs: intervals.length ? Math.round(intervals[intervals.length - 1]) : null,
    perSecond: span ? Math.round(((times.length - 1) / span) * 10000) / 10 : null,
  };
}

/**
 * The recorder's own frame interval: the median gap between captured frames inside runs of motion, never under one
 * 60 Hz refresh. A recorder that captures at 30 fps would otherwise make every animation look like it dropped half
 * its frames.
 * @param {Video} video @param {Run[]} motion
 */
export function captureMs(video, motion) {
  const gaps = motion
    .flatMap((run) => Array.from({ length: run.to - run.from }, (_, k) => video.frames[run.from + k + 1].t - video.frames[run.from + k].t))
    .sort((a, b) => a - b);
  return gaps.length ? Math.max(REFRESH_MS, quantile(gaps, 0.5)) : REFRESH_MS;
}

/**
 * Frames missed while something moved: inside each run, a gap between captured frames longer than 1.5 refreshes
 * counts the refreshes it skipped. A screen recording captures the frames the screen drew, so a skipped refresh in
 * the middle of an animation is a frame the app did not draw in time. A refresh is the recorder's own interval
 * (captureMs) unless given.
 * @param {Video} video @param {Run[]} motion
 */
export function droppedFrames(video, motion, refreshMs = captureMs(video, motion)) {
  let dropped = 0;
  /** @type {{ at: number, ms: number }[]} */
  const stalls = [];
  for (const run of motion) {
    for (let i = run.from + 1; i <= run.to; i += 1) {
      const gap = video.frames[i].t - video.frames[i - 1].t;
      if (gap <= refreshMs * 1.5) continue;
      dropped += Math.round(gap / refreshMs) - 1;
      stalls.push({ at: Math.round(video.frames[i - 1].t), ms: Math.round(gap) });
    }
  }
  return { dropped, stalls, captureHz: Math.round(1000 / refreshMs) };
}

/** Content that jumped: frames whose region lines up with the frame before only after a vertical shift, in source px. */
export function layoutShift(/** @type {Video} */ video, /** @type {Rect} */ rect, maxPx = 200) {
  const max = Math.round(maxPx / video.scale);
  /** @type {{ at: number, dy: number }[]} */
  const shifts = [];
  let prev = profile(video, video.frames[0].px, rect, 'y');
  for (let i = 1; i < video.frames.length; i += 1) {
    const cur = profile(video, video.frames[i].px, rect, 'y');
    const dy = bestShift(prev, cur, max) * video.scale;
    if (dy) shifts.push({ at: Math.round(video.frames[i].t), dy });
    prev = cur;
  }
  return { shifts, totalPx: shifts.reduce((s, x) => s + Math.abs(x.dy), 0) };
}

/** When progress first reached `level` (0–1), as ms after the run's start, interpolated between frames; null if never. */
export function timeTo(/** @type {import('./fit.mjs').Point[]} */ points, /** @type {number} */ level, /** @type {number} */ spanMs) {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (b.p < level) continue;
    const k = b.p === a.p ? 1 : (level - a.p) / (b.p - a.p);
    return Math.round((a.u + Math.min(1, Math.max(0, k)) * (b.u - a.u)) * spanMs);
  }
  return null;
}

/** The progress points of a run, or null when its first and last frames are the same (nothing moved). */
function moved(/** @type {Video} */ video, /** @type {Rect} */ region, /** @type {Run} */ run, /** @type {'blend' | 'x' | 'y'} */ mode) {
  try {
    return progress(video, region, run.from, run.to, mode);
  } catch {
    // progress() throws only for a run with no net change
    return null;
  }
}

/**
 * One animation in a region: the first run of change ending at or after `after` ms, carried to where it settled; its
 * duration, the time it took to reach 95% (steadier than the end, whose last steps can be too small to see), how far
 * it overshot, and the cubic-bezier that fits its progress, with the palette's named curves ranked against it.
 * @param {Video} video
 * @param {{ region: Rect, mode?: 'blend' | 'x' | 'y', after?: number, palette?: Record<string, import('./fit.mjs').Curve>, minMass?: number, mergeMs?: number }} o
 */
export function transition(video, { region, mode = 'blend', after = Number.NEGATIVE_INFINITY, palette = {}, minMass, mergeMs }) {
  const series = changeSeries(video, region);
  // the first run after `after` whose first and last frames differ: a flicker that came back to where it was is not one
  /** @type {Run | null} */
  let run = null;
  /** @type {import('./fit.mjs').Point[] | null} */
  let points = null;
  for (const found of runs(series, { minMass, mergeMs }).filter((r) => r.end >= after)) {
    run = settle(series, found, mergeMs);
    points = moved(video, region, run, mode);
    if (points) break;
  }
  if (!run || !points) return null;
  const fit = fitBezier(points);
  const span = run.end - run.start;
  return {
    startMs: Math.round(run.start),
    durationMs: Math.round(span),
    to95Ms: timeTo(points, 0.95, span),
    frames: run.to - run.from,
    overshoot: Math.round(Math.max(0, ...points.map((p) => p.p - 1)) * 1000) / 1000,
    curve: fit.curve,
    rmse: fit.rmse,
    nearest: nearest(points, palette).slice(0, 3),
    dropped: droppedFrames(video, [run]).dropped,
  };
}
