// Motion bench Sky-model fit (#3810): a measured cursor move fitted to an arc (one cubic bulging off the chord) driven by a spring, the spring and arc a reference planner (shared/cursorMotionPlan.mjs, else a stub built from the recovered Sky constants) predicts, and the error between the two.
import { minimize } from './fit.mjs';
import { chordFrame } from './cursor.mjs';
import { quantile, rms, round } from './stats.mjs';

/** @typedef {{ x: number, y: number }} Xy */
/** @typedef {{ durationMs: number, positionAt: (tMs: number) => Xy }} PlannedMove one planned move: how long it takes and where the cursor is `tMs` after it starts */
/** @typedef {(from: Xy, to: Xy, bounds: [number, number]) => PlannedMove} Planner what the report compares a measured move with; shared/cursorMotionPlan.mjs's planMove and sampleAt are adapted to it */

/** The constants recovered from SkyComputerUseService 26.1027 (static analysis, not yet reconciled with a recording). */
export const SKY = {
  scootDistance: 196,
  springDamping: 0.9,
  responseScaler: 0.9,
  responseMin: 0.12,
  responseMax: 2.2,
  scootResponse: 0.24,
  scootDamping: 0.84,
  arcSize: 0.2766,
  clickAngleDegrees: -44,
};

/**
 * Progress of a unit step through a SwiftUI-style spring: `response` is the period of the undamped spring in seconds,
 * `damping` the damping fraction (at 1 and above, critically damped). Starts at 0 with no velocity; 0 before t = 0.
 */
export function springStep(/** @type {number} */ t, /** @type {number} */ response, /** @type {number} */ damping) {
  if (t <= 0) return 0;
  const w = (2 * Math.PI) / response;
  if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
}

/** A cubic Bezier through `a` and `d` with controls `b` and `c`, at parameter s. */
export function cubicAt(/** @type {Xy} */ a, /** @type {Xy} */ b, /** @type {Xy} */ c, /** @type {Xy} */ d, /** @type {number} */ s) {
  const k = 1 - s;
  const f = (/** @type {'x' | 'y'} */ axis) =>
    k * k * k * a[axis] + 3 * k * k * s * b[axis] + 3 * k * s * s * c[axis] + s * s * s * d[axis];
  return { x: f('x'), y: f('y') };
}

/** The arc's controls: the chord's thirds pushed sideways by `k1` and `k2` of the chord's length (positive to the right of travel). */
export function arcControls(/** @type {Xy} */ a, /** @type {Xy} */ b, k1 = 0, k2 = 0) {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const at = (/** @type {number} */ along, /** @type {number} */ side) => ({
    x: a.x + ux * along * length + -uy * side * length,
    y: a.y + uy * along * length + ux * side * length,
  });
  return { c1: at(1 / 3, k1), c2: at(2 / 3, k2) };
}

/** @typedef {{ response: number, damping: number, t0Ms: number, k1: number, k2: number }} ModelParams */

/** Where the model puts the cursor `tMs` after the move's measured start. */
export function modelPoint(/** @type {ModelParams} */ p, /** @type {Xy} */ a, /** @type {Xy} */ b, /** @type {number} */ tMs) {
  const { c1, c2 } = arcControls(a, b, p.k1, p.k2);
  return cubicAt(a, c1, c2, b, springStep((tMs - p.t0Ms) / 1000, p.response, p.damping));
}

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));
const bound = (/** @type {number[]} */ x) => ({
  response: clamp(x[0], 0.03, 2.5),
  damping: clamp(x[1], 0.3, 1.2),
  t0Ms: clamp(x[2], -0.15, 0.15) * 1000,
  k1: clamp(x[3], -1, 1),
  k2: clamp(x[4], -1, 1),
});

/**
 * A move fitted to the arc-and-spring model: response, damping, start offset (ms from the first point) and the two arc
 * offsets, by least squares on position over the move's frames. Also fitted with a straight path (arc offsets 0) so
 * the gain from the arc shows. Errors are px between the model and the measured cursor.
 * @param {import('./cursor.mjs').Move} move
 */
export function fitMove(move) {
  const a = move.start;
  const b = move.end;
  const rel = move.points.map((p) => ({ t: p.t - move.t0, x: p.x, y: p.y }));
  const errors = (/** @type {ModelParams} */ p) =>
    rel.map((q) => {
      const m = modelPoint(p, a, b, q.t);
      return Math.hypot(m.x - q.x, m.y - q.y);
    });
  const guess = Math.max(0.05, move.durationMs / 1000 / 3.4);
  const starts = [guess, guess / 2, guess * 2];
  const best = (/** @type {boolean} */ arc) => {
    let top = { x: /** @type {number[]} */ ([]), v: Number.POSITIVE_INFINITY };
    for (const r of starts) {
      const r0 = minimize(
        (x) => /** @type {number} */ (rms(errors(bound(arc ? x : [x[0], x[1], x[2], 0, 0])))),
        [r, 0.9, 0, arc ? 0.05 : 0, arc ? -0.05 : 0],
        0.1,
        500,
      );
      if (r0.v < top.v) top = r0;
    }
    return bound(arc ? top.x : [top.x[0], top.x[1], top.x[2], 0, 0]);
  };
  const fitted = best(true);
  const straight = best(false);
  const e = errors(fitted);
  const straightRms = /** @type {number} */ (rms(errors(straight)));
  const arcRms = /** @type {number} */ (rms(e));
  return {
    response: round(fitted.response, 3),
    damping: round(fitted.damping, 3),
    t0Ms: round(fitted.t0Ms),
    arc: [round(fitted.k1, 3), round(fitted.k2, 3)],
    rmsPx: round(arcRms, 2),
    p95Px: round(/** @type {number} */ (quantile(e, 0.95)), 2),
    maxPx: round(Math.max(...e), 2),
    straightRmsPx: round(straightRms, 2),
    arcGainPx: round(straightRms - arcRms, 2),
  };
}

/**
 * A move against a planner's plan for the same start and end: the plan's position at each measured frame (shifted in time
 * by up to 150 ms either way for the best fit), its error in px, and the durations.
 * @param {import('./cursor.mjs').Move} move @param {Planner} planner @param {[number, number]} bounds
 */
export function compareToPlanner(move, planner, bounds) {
  const plan = planner(move.start, move.end, bounds);
  const rel = move.points.map((p) => ({ t: p.t - move.t0, x: p.x, y: p.y }));
  const errorsAt = (/** @type {number} */ shift) =>
    rel.map((q) => {
      const p = plan.positionAt(q.t - shift);
      return Math.hypot(p.x - q.x, p.y - q.y);
    });
  let shift = 0;
  let best = /** @type {number} */ (rms(errorsAt(0)));
  for (let s = -150; s <= 150; s += 5) {
    const r = /** @type {number} */ (rms(errorsAt(s)));
    if (r < best - 1e-9) {
      best = r;
      shift = s;
    }
  }
  const e = errorsAt(shift);
  return {
    rmsPx: round(best, 2),
    p95Px: round(/** @type {number} */ (quantile(e, 0.95)), 2),
    offsetMs: shift,
    plannedMs: round(plan.durationMs),
    measuredMs: round(move.durationMs),
    durationRatio: round(move.durationMs / plan.durationMs, 3),
  };
}

/** Path statistics of an arc cubic sampled like the Sky planner does (24 chords): length, summed turn, summed squared turn, largest turn. */
function arcStats(/** @type {Xy} */ a, /** @type {Xy} */ c1, /** @type {Xy} */ c2, /** @type {Xy} */ b) {
  let length = 0;
  let turnSum = 0;
  let turnSquares = 0;
  let prev = a;
  let heading = /** @type {number | null} */ (null);
  for (let k = 1; k <= 24; k += 1) {
    const p = cubicAt(a, c1, c2, b, k / 24);
    length += Math.hypot(p.x - prev.x, p.y - prev.y);
    const h = Math.atan2(p.y - prev.y, p.x - prev.x);
    if (heading !== null) {
      const turn = Math.abs(Math.atan2(Math.sin(h - heading), Math.cos(h - heading)));
      turnSum += turn;
      turnSquares += turn * turn;
    }
    heading = h;
    prev = p;
  }
  return { length, turnSum, turnSquares };
}

/**
 * The reference planner when shared/cursorMotionPlan.mjs does not exist yet: a stand-in built from the recovered Sky
 * constants. At 196 px and under, a straight move on one spring (response 0.24, damping 0.84); above it one arc, on the side the
 * click angle favours, offset by 0.2766 of the distance, driven by a spring whose response grows with the path's length
 * and turning (the formula recovered from the binary). It plans one arc, not Sky's best of twenty candidates.
 * @type {Planner}
 */
export function stubPlanner(from, to) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const straight = distance <= SKY.scootDistance;
  const t0 = (SKY.clickAngleDegrees * Math.PI) / 180;
  const side = (to.x - from.x) * Math.cos(t0) - (to.y - from.y) * Math.sin(t0) < 0 ? -1 : 1;
  const bulge = straight ? 0 : side * SKY.arcSize;
  const { c1, c2 } = arcControls(from, to, bulge, bulge);
  let response = SKY.scootResponse;
  let damping = SKY.scootDamping;
  if (!straight) {
    const { length, turnSum, turnSquares } = arcStats(from, c1, c2, to);
    const unit = (/** @type {number} */ c) => Math.min(1, Math.max(0, c));
    const detour = Math.max(0, length / Math.max(distance, 1) - 1);
    const t = (SKY.clickAngleDegrees * Math.PI) / 180;
    const backtrack = unit((-0.08 - ((to.x - from.x) * Math.sin(t) + (to.y - from.y) * Math.cos(t)) / distance) / 0.92);
    const f = 0.42 * unit(detour / 0.55) + 0.38 * unit(turnSum / 4.398) + 0.2 * unit(turnSquares / 1.25);
    const total = 0.28 * backtrack + (0.22 * unit((length - 180) / 760) + 0.42) + 0.12 * unit(f) + 0.04;
    response = clamp(SKY.responseScaler * 0.9 * total, SKY.responseMin, SKY.responseMax);
    damping = SKY.springDamping;
  }
  const positionAt = (/** @type {number} */ tMs) => cubicAt(from, c1, c2, to, springStep(tMs / 1000, response, damping));
  let durationMs = 0;
  for (let ms = 0; ms <= 6000; ms += 4) if (Math.abs(springStep(ms / 1000, response, damping) - 1) > 0.005) durationMs = ms;
  return { durationMs, positionAt };
}

/** The shared planner (`planMove` and `sampleAt` of shared/cursorMotionPlan.mjs) as a Planner: the screen is the bounds rect. */
function sharedPlanner(/** @type {any} */ mod) {
  return /** @type {Planner} */ (
    (from, to, bounds) => {
      const plan = mod.planMove({ from, to, bounds: { x: 0, y: 0, width: bounds[0], height: bounds[1] } });
      return {
        durationMs: plan.durationMs,
        positionAt: (tMs) => {
          const s = mod.sampleAt(plan, tMs);
          return { x: s.x, y: s.y };
        },
      };
    }
  );
}

/**
 * The reference planner: shared/cursorMotionPlan.mjs when it has `planMove` and `sampleAt`, the stub otherwise. Says which.
 * @param {() => Promise<any>} [importer]
 * @returns {Promise<{ planner: Planner, source: string }>}
 */
export async function loadPlanner(importer = () => import('../../../shared/cursorMotionPlan.mjs')) {
  try {
    const mod = await importer();
    if (typeof mod.planMove === 'function' && typeof mod.sampleAt === 'function')
      return { planner: sharedPlanner(mod), source: 'shared/cursorMotionPlan.mjs' };
  } catch {
    // the shared planner is not there: the stub stands in
  }
  return { planner: stubPlanner, source: 'stub from the recovered Sky constants' };
}

/** A move's path in its chord frame for the metrics file: [ms from the start, u along the chord, v across it], px, rounded to 0.1. */
export function pathSummary(/** @type {import('./cursor.mjs').Move} */ move) {
  return chordFrame(move.points).map((p) => [round(p.t), round(p.u), round(p.v)]);
}
