// Motion bench alignment (#3810): one recorded move laid over another in the chord frame (path RMS, duration, per-frame position error after the best time shift, timing offset) against a numeric "aligned" tolerance, and scalar metrics compared as vendor / MoPilot / delta.
import { quantile, rms, round } from './stats.mjs';

/** @typedef {[number, number, number]} PathPoint [ms from the move's start, u along the chord, v across it] in px */

/**
 * When two moves count as aligned. Path RMS: the symmetric distance between the two drawn paths. Duration: the share
 * the durations differ by. Frame error: the 95th percentile of the position gap per frame once the timing offset is removed.
 * Offset: the best time shift, in 60 Hz frames.
 */
export const ALIGN_TOLERANCE = {
  pathRmsPx: 4,
  durationShare: 0.08,
  frameErrorP95Px: 6,
  offsetFrames: 1,
  frameMs: 1000 / 60,
  scaleShare: 0.02,
};

/** A path's position at `t` ms, linearly between its points, held at its ends. */
export function pathAt(/** @type {PathPoint[]} */ path, /** @type {number} */ t) {
  if (t <= path[0][0]) return { u: path[0][1], v: path[0][2] };
  const last = path[path.length - 1];
  if (t >= last[0]) return { u: last[1], v: last[2] };
  let k = 1;
  while (path[k][0] < t) k += 1;
  const f = (t - path[k - 1][0]) / (path[k][0] - path[k - 1][0]);
  return { u: path[k - 1][1] + f * (path[k][1] - path[k - 1][1]), v: path[k - 1][2] + f * (path[k][2] - path[k - 1][2]) };
}

/** The distance from a point to a polyline of path points. */
function toPolyline(/** @type {PathPoint[]} */ path, /** @type {number} */ u, /** @type {number} */ v) {
  let best = Math.hypot(u - path[0][1], v - path[0][2]);
  for (let k = 1; k < path.length; k += 1) {
    const [, au, av] = path[k - 1];
    const [, bu, bv] = path[k];
    const len2 = (bu - au) ** 2 + (bv - av) ** 2;
    const f = len2 ? Math.min(1, Math.max(0, ((u - au) * (bu - au) + (v - av) * (bv - av)) / len2)) : 0;
    best = Math.min(best, Math.hypot(u - (au + f * (bu - au)), v - (av + f * (bv - av))));
  }
  return best;
}

/**
 * Two recorded moves of the same planned move laid over each other. `a` is the reference (the vendor), `b` ours. When
 * their lengths differ by over `scaleShare` (a different viewport), `a` is scaled to `b`'s length first. Returns the
 * metrics, whether each is inside the tolerance, and `aligned` when all are.
 * @param {PathPoint[]} a @param {PathPoint[]} b @param {Partial<typeof ALIGN_TOLERANCE>} [tolerance]
 */
export function alignMoves(a, b, tolerance = {}) {
  const tol = { ...ALIGN_TOLERANCE, ...tolerance };
  const lengthA = a[a.length - 1][1];
  const lengthB = b[b.length - 1][1];
  const scaled = Math.abs(lengthA - lengthB) / lengthB > tol.scaleShare;
  const k = scaled ? lengthB / lengthA : 1;
  const ref = /** @type {PathPoint[]} */ (a.map(([t, u, v]) => [t, u * k, v * k]));
  const near = (/** @type {PathPoint[]} */ x, /** @type {PathPoint[]} */ y) =>
    /** @type {number} */ (rms(x.map(([, u, v]) => toPolyline(y, u, v))));
  const pathRms = Math.sqrt((near(ref, b) ** 2 + near(b, ref) ** 2) / 2);
  const gaps = (/** @type {number} */ offset) =>
    ref.map(([t, u, v]) => {
      const p = pathAt(b, t + offset);
      return Math.hypot(p.u - u, p.v - v);
    });
  // how far b lags a (ms): b at t + offset is where a is at t, so a later b has a positive offset
  let offset = 0;
  let best = /** @type {number} */ (rms(gaps(0)));
  for (let o = -3 * tol.frameMs; o <= 3 * tol.frameMs + 1e-9; o += tol.frameMs / 4) {
    const r = /** @type {number} */ (rms(gaps(o)));
    if (r < best - 1e-9) {
      best = r;
      offset = o;
    }
  }
  const durationA = a[a.length - 1][0];
  const durationB = b[b.length - 1][0];
  const metrics = {
    pathRmsPx: round(pathRms, 2),
    durationShare: round(Math.abs(durationA - durationB) / durationA, 3),
    frameErrorP95Px: round(quantile(gaps(offset), 0.95), 2),
    offsetFrames: round(offset / tol.frameMs, 2),
    scaled,
  };
  const checks = {
    pathRmsPx: /** @type {number} */ (metrics.pathRmsPx) <= tol.pathRmsPx,
    durationShare: /** @type {number} */ (metrics.durationShare) <= tol.durationShare,
    frameErrorP95Px: /** @type {number} */ (metrics.frameErrorP95Px) <= tol.frameErrorP95Px,
    offsetFrames: Math.abs(/** @type {number} */ (metrics.offsetFrames)) <= tol.offsetFrames,
  };
  return { ...metrics, checks, aligned: Object.values(checks).every(Boolean) };
}

/**
 * @typedef {{ key: string, label: string, unit: string, better: 'lower' | 'higher' | null, abs?: number, rel?: number }} MetricSpec one scalar the report compares:
 *   where it sits in an analysis (dotted key), which direction is better, and how close counts as aligned (absolute and/or relative)
 */

/** Reads a dotted key from nested objects; undefined when any step is missing. */
export function get(/** @type {any} */ object, /** @type {string} */ key) {
  return key.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), object);
}

/**
 * One scalar compared: vendor value, ours, the difference (ours - vendor) and a verdict. `aligned` when within the
 * spec's absolute or relative tolerance, else `better` or `worse` by the spec's direction (`differs` for a metric with no better side), `n/a` when either is missing.
 * @param {MetricSpec} spec @param {number | null | undefined} vendor @param {number | null | undefined} ours
 */
export function compareScalar(spec, vendor, ours) {
  if (typeof vendor !== 'number' || typeof ours !== 'number')
    return { ...spec, vendor: vendor ?? null, ours: ours ?? null, delta: null, deltaPct: null, verdict: 'n/a' };
  const delta = ours - vendor;
  const within =
    (spec.abs !== undefined && Math.abs(delta) <= spec.abs) || (spec.rel !== undefined && Math.abs(delta) <= spec.rel * Math.abs(vendor));
  /** @type {string} */
  let verdict = 'differs';
  if (within) verdict = 'aligned';
  else if (spec.better) verdict = (spec.better === 'lower') === delta < 0 ? 'better' : 'worse';
  return {
    ...spec,
    vendor,
    ours,
    delta: round(delta, 2),
    deltaPct: vendor ? round((delta / Math.abs(vendor)) * 100) : null,
    verdict,
  };
}

/**
 * The scalar metrics the report compares: cursor rate and jitter, fit, latency, activity, overlay, jank, cost and pass rate.
 * Defaults to propose: ±1 frame (16.7 ms) for timings, 10% for rates and durations, ±1 px for fit error.
 * @type {MetricSpec[]}
 */
export const METRIC_SPECS = [
  { key: 'cursor.fps', label: 'Cursor update rate', unit: 'fps', better: 'higher', rel: 0.1 },
  { key: 'cursor.updates.p50', label: 'Cursor frame interval p50', unit: 'ms', better: 'lower', abs: 1000 / 60 },
  { key: 'cursor.updates.p95', label: 'Cursor frame interval p95', unit: 'ms', better: 'lower', abs: 1000 / 60 },
  { key: 'cursor.updates.jitter', label: 'Cursor frame-time jitter (p95 - p50)', unit: 'ms', better: 'lower', abs: 1000 / 60 },
  { key: 'cursor.captureFps', label: 'Recorder frame rate', unit: 'fps', better: 'higher', rel: 0.1 },
  { key: 'fit.rmsPx', label: 'Arc + spring fit error (median)', unit: 'px', better: 'lower', abs: 1 },
  { key: 'fit.arcGainPx', label: 'Gain of an arc over a straight path (median)', unit: 'px', better: null, abs: 1 },
  { key: 'fit.response', label: 'Fitted spring response (median)', unit: 's', better: null, rel: 0.1 },
  { key: 'fit.damping', label: 'Fitted spring damping (median)', unit: '', better: null, abs: 0.05 },
  { key: 'moves.durationMs', label: 'Move duration (median)', unit: 'ms', better: 'lower', rel: 0.08 },
  { key: 'moves.straightness', label: 'Path length over distance (median)', unit: '', better: null, abs: 0.02 },
  { key: 'latency.firstActionMs', label: 'Time to first action', unit: 'ms', better: 'lower', abs: 1000 / 60 },
  { key: 'latency.thinkMs', label: 'Pause before the cursor moves (median)', unit: 'ms', better: 'lower', abs: 1000 / 60 },
  { key: 'latency.dwellMs', label: 'Arrival to click (median)', unit: 'ms', better: 'lower', abs: 1000 / 60 },
  { key: 'latency.feedbackMs', label: 'Click to visible page feedback (median)', unit: 'ms', better: 'lower', abs: 1000 / 60 },
  { key: 'actions.click.p50', label: 'Per-action wall time: click', unit: 'ms', better: 'lower', rel: 0.1 },
  { key: 'actions.type.p50', label: 'Per-action wall time: type', unit: 'ms', better: 'lower', rel: 0.1 },
  { key: 'actions.scroll.p50', label: 'Per-action wall time: scroll', unit: 'ms', better: 'lower', rel: 0.1 },
  { key: 'actions.screenshot.p50', label: 'Per-action wall time: screenshot', unit: 'ms', better: 'lower', rel: 0.1 },
  { key: 'gaps.longestMs', label: 'Longest stretch with no visible activity', unit: 'ms', better: 'lower', abs: 100 },
  { key: 'gaps.count', label: 'Stretches over 1 s with no visible activity', unit: '', better: 'lower', abs: 0 },
  { key: 'overlay.updatesPerSecond', label: 'Overlay / thumbnail update cadence', unit: '/s', better: null, rel: 0.1 },
  { key: 'jank.longTasksPerMin', label: 'Long tasks per minute (renderer)', unit: '/min', better: 'lower', abs: 1 },
  { key: 'jank.blockingMs', label: 'Total blocking time (renderer)', unit: 'ms', better: 'lower', rel: 0.1 },
  { key: 'cost.steps', label: 'Steps per task', unit: '', better: 'lower', rel: 0.1 },
  { key: 'cost.tokens', label: 'Tokens per task', unit: '', better: 'lower', rel: 0.1 },
  { key: 'cost.passRate', label: 'Pass rate', unit: '', better: 'higher', abs: 0 },
];

/** Every metric of the table for two analyses (vendor, ours). */
export function compareAnalyses(/** @type {any} */ vendor, /** @type {any} */ ours, /** @type {MetricSpec[]} */ specs = METRIC_SPECS) {
  return specs.map((spec) => compareScalar(spec, get(vendor, spec.key), get(ours, spec.key)));
}

/**
 * Moves of two analyses (`moves.list`, each with `key`, `path`) paired by key and aligned. A move only one side has is listed with `aligned: null`.
 * @param {any} vendor @param {any} ours @param {Partial<typeof ALIGN_TOLERANCE>} [tolerance]
 */
export function alignAnalyses(vendor, ours, tolerance) {
  /** @type {any[]} */
  const a = get(vendor, 'moves.list') ?? [];
  /** @type {any[]} */
  const b = get(ours, 'moves.list') ?? [];
  const keys = [...new Set([...a, ...b].map((m) => m.key))];
  return keys.map((key) => {
    const x = a.find((m) => m.key === key);
    const y = b.find((m) => m.key === key);
    if (!x?.path || !y?.path) return { key, aligned: null, vendorPath: x?.path ?? null, oursPath: y?.path ?? null };
    return { key, vendorPath: x.path, oursPath: y.path, ...alignMoves(x.path, y.path, tolerance) };
  });
}
