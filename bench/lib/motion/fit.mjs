// Motion bench: an animation's progress over its frames (a blend between its first and last frame, or a shift along an axis), and the cubic-bezier curve and named easing that fit it.
import { bestShift, cells, profile } from './frames.mjs';

/** @typedef {import('./frames.mjs').Video} Video */
/** @typedef {import('./frames.mjs').Rect} Rect */
/** @typedef {[number, number, number, number]} Curve cubic-bezier(x1, y1, x2, y2) */
/** @typedef {{ u: number, p: number }} Point time fraction `u` and progress `p` (0 at the start, 1 at the end) */

/** cubic-bezier(x1, y1, x2, y2) at time fraction `u`: x is solved by bisection, then y is read at that parameter. */
export function bezierAt(/** @type {Curve} */ [x1, y1, x2, y2], /** @type {number} */ u) {
  const c = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ s) =>
    3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const m = (lo + hi) / 2;
    if (c(x1, x2, m) < u) lo = m;
    else hi = m;
  }
  return c(y1, y2, (lo + hi) / 2);
}

/** Root mean square distance between the points and a curve. */
export function rmse(/** @type {Point[]} */ points, /** @type {Curve} */ curve) {
  let sum = 0;
  for (const { u, p } of points) sum += (bezierAt(curve, u) - p) ** 2;
  return Math.sqrt(sum / points.length);
}

/** x control points stay in [0, 1] (CSS requires it); y control points in [-1, 2]. */
const clampCurve = (/** @type {number[]} */ c) =>
  /** @type {Curve} */ ([
    Math.min(1, Math.max(0, c[0])),
    Math.min(2, Math.max(-1, c[1])),
    Math.min(1, Math.max(0, c[2])),
    Math.min(2, Math.max(-1, c[3])),
  ]);

/** Nelder–Mead minimization of `f` from `start`, a fixed number of iterations: deterministic, no randomness. */
export function minimize(/** @type {(x: number[]) => number} */ f, /** @type {number[]} */ start, step = 0.2, iterations = 400) {
  const n = start.length;
  /** @type {{ x: number[], v: number }[]} */
  let simplex = [{ x: start, v: f(start) }];
  for (let i = 0; i < n; i += 1) {
    const x = start.slice();
    x[i] += step;
    simplex.push({ x, v: f(x) });
  }
  const along = (/** @type {number[]} */ a, /** @type {number[]} */ b, /** @type {number} */ k) => a.map((ai, i) => ai + k * (b[i] - ai));
  for (let it = 0; it < iterations; it += 1) {
    simplex.sort((a, b) => a.v - b.v);
    const worst = simplex[n];
    const centroid = start.map((_, i) => simplex.slice(0, n).reduce((s, p) => s + p.x[i], 0) / n);
    const r = along(centroid, worst.x, -1);
    const vr = f(r);
    if (vr < simplex[0].v) {
      const e = along(centroid, worst.x, -2);
      const ve = f(e);
      simplex[n] = ve < vr ? { x: e, v: ve } : { x: r, v: vr };
    } else if (vr < simplex[n - 1].v) {
      simplex[n] = { x: r, v: vr };
    } else {
      const c = along(centroid, worst.x, 0.5);
      const vc = f(c);
      if (vc < worst.v) simplex[n] = { x: c, v: vc };
      else {
        const best = simplex[0].x;
        simplex = simplex.map((p, i) => {
          if (!i) return p;
          const x = along(best, p.x, 0.5);
          return { x, v: f(x) };
        });
      }
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return simplex[0];
}

/** Starting curves for the fit: linear, ease, ease-out, a strong ease-out and an overshoot. */
const STARTS = /** @type {Curve[]} */ ([
  [0.33, 0.33, 0.67, 0.67],
  [0.25, 0.1, 0.25, 1],
  [0, 0, 0.58, 1],
  [0.2, 0.8, 0.2, 1],
  [0.34, 1.4, 0.64, 1],
]);

/** The cubic-bezier closest to the points, rounded to three places, and its error. */
export function fitBezier(/** @type {Point[]} */ points) {
  if (points.length < 2) throw new Error('a curve needs at least two points');
  const cost = (/** @type {number[]} */ c) => rmse(points, clampCurve(c));
  /** @type {{ x: number[], v: number }} */
  let best = { x: STARTS[0], v: Number.POSITIVE_INFINITY };
  for (const start of STARTS) {
    const r = minimize(cost, start);
    if (r.v < best.v - 1e-12) best = r;
  }
  const curve = /** @type {Curve} */ (clampCurve(best.x).map((v) => Math.round(v * 1000) / 1000));
  return { curve, rmse: Math.round(rmse(points, curve) * 10000) / 10000 };
}

/** Named curves (a vendor's easing tokens, CSS keywords) ranked by their distance to the points, closest first. */
export function nearest(/** @type {Point[]} */ points, /** @type {Record<string, Curve>} */ palette) {
  return Object.entries(palette)
    .map(([name, curve]) => ({ name, rmse: Math.round(rmse(points, curve) * 10000) / 10000 }))
    .sort((a, b) => a.rmse - b.rmse || (a.name < b.name ? -1 : 1));
}

/**
 * Progress of an animation between frame `from` (its last still frame) and frame `to` (where it settled), one point
 * per frame between them. `blend` projects each frame onto the change from first to last (fades, color, any
 * cross-fade); `x` and `y` track the shift that lines each frame up with the last (slides, scrolling).
 * @param {Video} video @param {Rect} rect @param {number} from @param {number} to @param {'blend' | 'x' | 'y'} mode
 * @returns {Point[]}
 */
export function progress(video, rect, from, to, mode) {
  const { frames } = video;
  const t0 = frames[from].t;
  const span = frames[to].t - t0;
  if (!(to > from) || span <= 0) throw new Error('an animation needs a later end frame');
  const u = (/** @type {number} */ i) => (frames[i].t - t0) / span;
  /** @type {Point[]} */
  const out = [];
  if (mode === 'blend') {
    const { x0, y0, x1, y1 } = cells(video, rect);
    const a = frames[from].px;
    const b = frames[to].px;
    let norm = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) norm += (b[y * video.width + x] - a[y * video.width + x]) ** 2;
    if (!norm) throw new Error('the first and last frames are the same: nothing moved');
    for (let i = from; i <= to; i += 1) {
      const f = frames[i].px;
      let dot = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const k = y * video.width + x;
          dot += (f[k] - a[k]) * (b[k] - a[k]);
        }
      }
      out.push({ u: u(i), p: dot / norm });
    }
    return out;
  }
  const end = profile(video, frames[to].px, rect, mode);
  const total = bestShift(profile(video, frames[from].px, rect, mode), end);
  if (!total) throw new Error(`nothing shifted along ${mode}`);
  for (let i = from; i <= to; i += 1) out.push({ u: u(i), p: 1 - bestShift(profile(video, frames[i].px, rect, mode), end) / total });
  return out;
}
