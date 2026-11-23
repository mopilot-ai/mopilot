// shared/cursorMotionPlan.mjs: harness-neutral cursor motion planner (#3810), pure and deterministic: the arc/scoot planner for long moves (planMove), the sampler, and the cursorMotion event acceptance rules; the default observed-Sky plan is in cursorApproach.mjs.

// Every constant block below is a static-analysis value, not confirmed by a recording; they feed the long-move branch (planMove) only.

/** Sample rate of every plan: clients interpolate with sampleAt() at their own frame rate. */
export const SAMPLE_HZ = 120;
/** Version of the cursorMotion event shape (field `v`). */
export const PLAN_EVENT_VERSION = 1;
/** Event kinds of the cursorMotion event. */
export const EVENT_KINDS = Object.freeze(['move', 'click', 'drag', 'type', 'scroll', 'hide']);

/**
 * Sky MotionConfiguration.live. Static-analysis value, not confirmed by a recording (#3810).
 * Angles in degrees, distances in px, responses in seconds.
 */
export const MOTION_CONFIG = Object.freeze({
  clickAngle: -44,
  candidateCount: 20,
  boundsMargin: 20,
  startHandle: 0.4196,
  endpointHandle: 0.15,
  arcSize: 0.2766,
  arcFlow: 0.5784,
  straightPathDistanceThreshold: 10,
  terminalTangentBlendStart: 0.99, // static-analysis value; no consumer recovered, not used by the planner
  springResponseScaler: 0.9,
  springResponseMin: 0.12,
  springResponseMax: 2.2,
  springDampingFraction: 0.9,
  scootDistanceThreshold: 196,
  scootPositionResponse: 0.24,
  scootPositionDamping: 0.84,
  scootPositionSettleVelocity: 12,
  scootAxisResponse: 0.07,
  scootAxisDamping: 0.82,
  scootBaseRotationResponse: 0.09, // static-analysis value; INFERRED to have no visible effect, not used
  scootBaseRotationDamping: 0.86,
  scootStretchResponse: 0.095,
  scootStretchDamping: 0.72,
  scootStretchMin: 0,
  scootStretchPivotX: 0.5,
  scootStretchXAmount: 0.38,
  scootSquashYAmount: 0.18,
  scootRotationResponse: 0.055,
  scootRotationDamping: 0.76,
  scootRotationMax: 76,
});

/** Candidate generator tables (arc offset scales x inner handle scales). Static-analysis value, not confirmed by a recording (#3810). */
export const CANDIDATE_TABLES = Object.freeze({
  arcScales: Object.freeze([0.55, 0.8, 1.05]),
  flowScales: Object.freeze([0.65, 1.0, 1.35]),
  handleMin: 48,
  handleMax: 640,
  handleChordCap: 0.9,
  arcMin: 50,
  arcMax: 520,
  flowMin: 38,
  flowMax: 440,
  samplesPerCubic: 24,
});

/** Candidate scoring weights. Static-analysis value, not confirmed by a recording (#3810). */
export const SCORE_WEIGHTS = Object.freeze({ detour: 320, sumSq: 140, maxTurn: 180, sumAbs: 18, backtrack: 90, outOfBounds: 44 });

/** Spring response formula constants. Static-analysis value, not confirmed by a recording (#3810). */
export const RESPONSE_TERMS = Object.freeze({
  lengthOffset: 180,
  lengthSpan: 760,
  detourSpan: 0.55,
  turnSpan: 1.4 * Math.PI,
  sumSqSpan: 1.25,
  backtrackFloor: -0.08,
  backtrackSpan: 0.92,
});

/**
 * Settle and arrival thresholds. Static-analysis value, not confirmed by a recording (#3810).
 * closeEnough values are the CloseEnoughConfiguration default (progress 0.995, distance 3.157 pt).
 */
export const TIMING = Object.freeze({
  settleDistance: 0.85, // px; from the JS-side Codex constants (A14)
  closeEnoughProgress: 0.995,
  closeEnoughDistance: 3.157,
  jumpDistance: 0.5, // px; below this the cursor snaps (A20)
  restEpsilon: 0.001,
  restVelocity: 0.05,
  substeps: 2, // spring integration runs at 2 x SAMPLE_HZ = 240 Hz (A8)
  maxPlanMs: 8000, // INFERRED safety cap, not in the binary
});

/** Scoot envelope constants. Static-analysis value, not confirmed by a recording (#3810). */
export const SCOOT_ENVELOPE = Object.freeze({ riseFraction: 0.22, decayPower: 0.62, tiltX: 0.75, tiltY: 0.62 });

const DEG = Math.PI / 180;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const clamp01 = (x) => clamp(x, 0, 1);
const isPoint = (p) => p !== null && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y);

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const unit = (a) => {
  const l = len(a);
  return l > 0 ? mul(a, 1 / l) : { x: 1, y: 0 };
};
const rotate = (a, rad) => ({ x: a.x * Math.cos(rad) - a.y * Math.sin(rad), y: a.x * Math.sin(rad) + a.y * Math.cos(rad) });

/** @returns {{x:number,y:number}} point on the cubic [p0,c1,c2,p3] at t (Bernstein basis) */
function cubicAt([p0, c1, c2, p3], t) {
  const m = 1 - t;
  const w0 = m * m * m;
  const w1 = 3 * m * m * t;
  const w2 = 3 * m * t * t;
  const w3 = t * t * t;
  return { x: w0 * p0.x + w1 * c1.x + w2 * c2.x + w3 * p3.x, y: w0 * p0.y + w1 * c1.y + w2 * c2.y + w3 * p3.y };
}

/** The unit heading the pointer tip faces under clickAngle: (sin t, cos t), as the backtrack term reads it. */
function clickHeading(cfg) {
  const t = cfg.clickAngle * DEG;
  return { x: Math.sin(t), y: Math.cos(t) };
}

/** How far a direction runs against the pointer heading, 0..1 (the "backtrack" factor). */
function backtrack(dir, cfg) {
  return clamp01((RESPONSE_TERMS.backtrackFloor - dot(dir, clickHeading(cfg))) / RESPONSE_TERMS.backtrackSpan);
}

/**
 * The straight path used for D <= straightPathDistanceThreshold, and for the scoot (D <= scootDistanceThreshold) line.
 * @returns {{segments: any[][], isStraight: boolean}}
 */
export function straightPath(from, to) {
  const d = sub(to, from);
  return { segments: [[from, add(from, mul(d, 1 / 3)), add(from, mul(d, 2 / 3)), to]], isStraight: true };
}

/**
 * The candidate paths between two points: 2 single cubics (one per bulge side) plus 3 arc sizes x 3 flows x 2 sides of two
 * joined cubics, 20 in all. INFERRED: the exact control-point roles; the start tangent is the chord turned by |clickAngle|
 * toward the bulge side, the end tangent follows the chord, and the side the clickAngle favours is listed first.
 * @returns {{segments: any[][], isStraight: boolean}[]}
 */
export function generateCandidates(from, to, config = MOTION_CONFIG) {
  const T = CANDIDATE_TABLES;
  const D = len(sub(to, from));
  const u = unit(sub(to, from));
  const n = { x: -u.y, y: u.x };
  const h = clickHeading(config);
  const favoured = u.x * h.y - u.y * h.x >= 0 ? 1 : -1; // INFERRED: sign(cross(u, heading)) picks the favoured side
  const handle = (k) => clamp(Math.min(D * k, D * T.handleChordCap), T.handleMin, T.handleMax); // INFERRED: floor wins over the 0.9 D cap
  const h0 = handle(config.startHandle);
  const h1 = handle(config.endpointHandle);
  const A = clamp(D * config.arcSize, T.arcMin, T.arcMax);
  const F = clamp(D * config.arcFlow, T.flowMin, T.flowMax);
  const turn = Math.abs(config.clickAngle) * DEG;
  const mid0 = mul(add(from, to), 0.5);
  const out = [];
  for (const side of [favoured, -favoured]) {
    const dirStart = rotate(u, side * turn);
    out.push({ segments: [[from, add(from, mul(dirStart, h0)), sub(to, mul(u, h1)), to]], isStraight: false });
  }
  for (const i of T.arcScales)
    for (const j of T.flowScales)
      for (const side of [favoured, -favoured]) {
        const mid = add(mid0, mul(n, side * A * i));
        const dirStart = rotate(u, side * turn);
        out.push({
          segments: [
            [from, add(from, mul(dirStart, h0)), sub(mid, mul(u, F * j)), mid],
            [mid, add(mid, mul(u, F * j)), sub(to, mul(u, h1)), to],
          ],
          isStraight: false,
        });
      }
  return out.slice(0, config.candidateCount); // INFERRED: the count is structural; slicing honours a smaller candidateCount
}

/**
 * A path flattened at 24 samples per cubic, with its length and heading-change statistics.
 * @returns {{points: {x:number,y:number}[], L: number, S2: number, Smax: number, Sabs: number, inBounds: boolean}}
 */
export function pathStats(path, bounds, config = MOTION_CONFIG) {
  const N = CANDIDATE_TABLES.samplesPerCubic;
  const points = [path.segments[0][0]];
  for (const seg of path.segments) for (let k = 1; k <= N; k++) points.push(k === N ? seg[3] : cubicAt(seg, k / N));
  const m = config.boundsMargin;
  const inside = (p) =>
    !bounds || (p.x >= bounds.x + m && p.x <= bounds.x + bounds.width - m && p.y >= bounds.y + m && p.y <= bounds.y + bounds.height - m);
  let L = 0;
  let S2 = 0;
  let Smax = 0;
  let Sabs = 0;
  let inBounds = true;
  let prevHeading = null;
  for (let i = 1; i < points.length; i++) {
    if (!inside(points[i])) inBounds = false;
    const d = sub(points[i], points[i - 1]);
    const l = len(d);
    L += l;
    if (l <= 0.001) continue;
    const heading = Math.atan2(d.y, d.x);
    if (prevHeading !== null) {
      let dt = heading - prevHeading;
      if (dt > Math.PI) dt -= 2 * Math.PI;
      else if (dt <= -Math.PI) dt += 2 * Math.PI;
      S2 += dt * dt;
      Smax = Math.max(Smax, Math.abs(dt));
      Sabs += Math.abs(dt);
    }
    prevHeading = heading;
  }
  return { points, L, S2, Smax, Sabs, inBounds };
}

/** Candidate score (lower is better): L + 320 detour + 140 S2 + 180 Smax + 18 Sabs + 90 backtrack + 44 out-of-bounds. */
export function scorePath(stats, D, startDir, config = MOTION_CONFIG) {
  const W = SCORE_WEIGHTS;
  const detour = Math.max(0, stats.L / Math.max(D, 1) - 1);
  // INFERRED: the backtrack term is read from the candidate's own start tangent, so it differs between candidates
  return (
    stats.L +
    W.detour * detour +
    W.sumSq * stats.S2 +
    W.maxTurn * stats.Smax +
    W.sumAbs * stats.Sabs +
    W.backtrack * backtrack(startDir, config) +
    W.outOfBounds * (stats.inBounds ? 0 : 1)
  );
}

/**
 * Picks the lowest-scoring candidate among those inside the bounds (all, if none is); ties keep the first.
 * @returns {{index: number, score: number, path: any, stats: any, count: number}}
 */
export function choosePath(from, to, bounds, config = MOTION_CONFIG) {
  const D = len(sub(to, from));
  const cands = generateCandidates(from, to, config).map((path) => {
    const stats = pathStats(path, bounds, config);
    const startDir = unit(sub(path.segments[0][1], path.segments[0][0]));
    return { path, stats, score: scorePath(stats, D, startDir, config) };
  });
  const pool = cands.some((c) => c.stats.inBounds) ? cands.filter((c) => c.stats.inBounds) : cands;
  let best = pool[0];
  for (const c of pool) if (c.score < best.score) best = c;
  return { index: cands.indexOf(best), score: best.score, path: best.path, stats: best.stats, count: cands.length };
}

/** Seconds of spring response for a path (larger is slower), clamped to [springResponseMin, springResponseMax]. */
export function springResponse(stats, D, isStraight, config = MOTION_CONFIG) {
  const R = RESPONSE_TERMS;
  const detour = Math.max(0, stats.L / Math.max(D, 1) - 1);
  const a = clamp01((stats.L - R.lengthOffset) / R.lengthSpan);
  const b = clamp01(detour / R.detourSpan);
  const c = clamp01(stats.Sabs / R.turnSpan);
  const d = clamp01(stats.S2 / R.sumSqSpan);
  const e = stats.backtrack ?? 0;
  const f = 0.42 * b + 0.38 * c + 0.2 * d;
  const total = 0.28 * e + (0.22 * a + 0.42) + 0.12 * clamp01(f) + (isStraight ? 0 : 0.04);
  const mult = isStraight ? 1 : 0.9;
  return Math.max(config.springResponseMin, Math.min(config.springResponseMax, config.springResponseScaler * mult * total));
}

/** One semi-implicit Euler step of a response/damping spring toward `target`. */
function stepSpring(s, target, response, damping, dt) {
  const w = (2 * Math.PI) / response;
  const a = w * w * (target - s.x) - 2 * damping * w * s.v;
  const v = s.v + a * dt;
  return { x: s.x + v * dt, v };
}

/** Position along a flattened path at fraction p of its length. */
function pointAtFraction(points, cum, p) {
  const total = cum[cum.length - 1];
  const s = clamp01(p) * total;
  let lo = 1;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  const seg = cum[lo] - cum[lo - 1];
  const k = (s - cum[lo - 1]) / Math.max(seg, 1e-12); // a zero-length step has s equal to its start, so k is 0
  return add(points[lo - 1], mul(sub(points[lo], points[lo - 1]), k));
}

const REST = Object.freeze({ scaleX: 1, scaleY: 1, pivotX: 0.5, tiltDeg: 0 });

/**
 * The long-move branch: plans a whole cursor move once, as a deterministic 120 Hz trajectory. Not the default: planApproach() is what a
 * cursor plays, and its start is never more than about 198 pt from the target; this arc planner is for moves above 196 pt, which no
 * recording has shown (static analysis, not confirmed).
 * D < 0.5 px jumps; D <= 10 px is a straight path under the distance spring; D <= 196 px is the scoot (straight line, position
 * spring .24/.84); beyond that the best of 20 arc candidates is driven by the distance-scaled progress spring. INFERRED: the
 * squash/stretch/tilt envelope runs on every non-jump move, and `seed` and `kind` do not change the motion (the choice is deterministic).
 * @param {{ from: {x:number,y:number}, to: {x:number,y:number}, bounds?: {x:number,y:number,width:number,height:number}, kind?: string }} input
 * @returns {{ mode: 'jump'|'straight'|'scoot'|'arc', kind: string, durationMs: number, samples: any[], arrivalIndex: number, response: number, selection: {index:number,count:number,score:number}|null }}
 */
export function planMove(input, config = MOTION_CONFIG) {
  const { from, to, bounds, kind = 'move' } = input ?? {};
  if (!isPoint(from) || !isPoint(to)) throw new TypeError('planMove: from and to must be finite points');
  if (!EVENT_KINDS.includes(kind)) throw new RangeError(`planMove: unknown kind ${kind}`);
  const D = len(sub(to, from));
  if (kind === 'hide' || D < TIMING.jumpDistance)
    return {
      mode: 'jump',
      kind,
      durationMs: 0,
      samples: [{ t: 0, x: to.x, y: to.y, progress: 1, ...REST }],
      arrivalIndex: 0,
      response: 0,
      selection: null,
    };

  let mode;
  let selection = null;
  let path;
  let stats;
  if (D <= config.straightPathDistanceThreshold) {
    mode = 'straight';
    path = straightPath(from, to);
  } else if (D <= config.scootDistanceThreshold) {
    mode = 'scoot';
    path = straightPath(from, to);
  } else {
    mode = 'arc';
    const c = choosePath(from, to, bounds, config);
    path = c.path;
    selection = { index: c.index, count: c.count, score: c.score };
  }
  stats = pathStats(path, bounds, config);
  stats.backtrack = backtrack(unit(sub(to, from)), config);
  const scoot = mode === 'scoot';
  const response = scoot ? config.scootPositionResponse : springResponse(stats, D, path.isStraight, config);
  const damping = scoot ? config.scootPositionDamping : config.springDampingFraction;

  const cum = [0];
  for (let i = 1; i < stats.points.length; i++) cum.push(cum[i - 1] + len(sub(stats.points[i], stats.points[i - 1])));
  const chord = sub(to, from);
  const dir = unit(chord);
  const flip = dir.x < 0 ? 1 : 0; // INFERRED: heading folded into [-90, 90] flips the pivot when moving leftwards
  const tiltSignal = clamp(SCOOT_ENVELOPE.tiltX * dir.x - SCOOT_ENVELOPE.tiltY * dir.y, -1, 1); // INFERRED from the JS-side scoot rotation target

  const dt = 1 / (SAMPLE_HZ * TIMING.substeps);
  let pr = { x: 0, v: 0 };
  let st = { x: 0, v: 0 };
  let ax = { x: 0.5, v: 0 };
  let ro = { x: 0, v: 0 };
  const samples = [];
  let arrivalIndex = -1;
  for (let i = 0; ; i++) {
    const tMs = (i * 1000) / SAMPLE_HZ;
    const pos = pointAtFraction(stats.points, cum, pr.x);
    const remaining = Math.abs(1 - pr.x) * D;
    const settled = remaining <= TIMING.settleDistance && Math.abs(pr.v) * D <= config.scootPositionSettleVelocity;
    const calm =
      Math.abs(st.x) < TIMING.restEpsilon &&
      Math.abs(ro.x) < TIMING.restEpsilon &&
      Math.abs(st.v) < TIMING.restVelocity &&
      Math.abs(ro.v) < TIMING.restVelocity;
    if ((settled && calm) || tMs >= TIMING.maxPlanMs) {
      samples.push({ t: tMs, x: to.x, y: to.y, progress: 1, ...REST });
      if (arrivalIndex < 0) arrivalIndex = i;
      break;
    }
    if (arrivalIndex < 0 && (pr.x >= TIMING.closeEnoughProgress || remaining <= TIMING.closeEnoughDistance)) arrivalIndex = i;
    const stretch = clamp(st.x, config.scootStretchMin, 1);
    samples.push({
      t: tMs,
      x: pos.x,
      y: pos.y,
      progress: clamp01(pr.x),
      scaleX: 1 + config.scootStretchXAmount * stretch,
      scaleY: 1 - config.scootSquashYAmount * stretch * (1 - config.scootStretchMin),
      pivotX: (1 - stretch) * config.scootStretchPivotX + stretch * ax.x,
      tiltDeg: ro.x * config.scootRotationMax,
    });
    for (let k = 0; k < TIMING.substeps; k++) {
      const t = clamp01(dot(sub(pointAtFraction(stats.points, cum, pr.x), from), chord) / (D * D));
      const env = clamp01(Math.min(1, t / SCOOT_ENVELOPE.riseFraction) * Math.pow(Math.max(0, 1 - t), SCOOT_ENVELOPE.decayPower));
      pr = stepSpring(pr, 1, response, damping, dt);
      st = stepSpring(st, env, config.scootStretchResponse, config.scootStretchDamping, dt);
      ax = stepSpring(ax, flip, config.scootAxisResponse, config.scootAxisDamping, dt);
      ro = stepSpring(ro, tiltSignal * env, config.scootRotationResponse, config.scootRotationDamping, dt);
      if (pr.x > 1) pr = { x: 1, v: 0 }; // the cursor cannot run past the end of the path
    }
  }
  return { mode, kind, durationMs: samples[samples.length - 1].t, samples, arrivalIndex, response, selection };
}

/**
 * The plan's state at tMs, linearly interpolated between the 120 Hz samples; clamped to the first and last sample.
 * @param {{ samples: any[] }} plan
 */
export function sampleAt(plan, tMs) {
  const s = plan.samples;
  const f = clamp((tMs * SAMPLE_HZ) / 1000, 0, s.length - 1);
  const i = Math.floor(f);
  if (i >= s.length - 1) return { ...s[s.length - 1] };
  const k = f - i;
  const out = {};
  // numbers interpolate; a label (the press state) is the earlier sample's
  for (const key of Object.keys(s[i])) out[key] = typeof s[i][key] === 'number' ? s[i][key] + (s[i + 1][key] - s[i][key]) * k : s[i][key];
  return out;
}

// ---- cursorMotion event (draft on #3810) ----

const isNonNegInt = (n) => Number.isInteger(n) && n >= 0;

/**
 * Validates a cursorMotion event.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateCursorMotionEvent(e) {
  if (e === null || typeof e !== 'object') return { ok: false, reason: 'not-an-object' };
  if (e.v !== PLAN_EVENT_VERSION) return { ok: false, reason: 'version' };
  for (const k of ['host', 'chatId', 'target']) if (typeof e[k] !== 'string' || !e[k]) return { ok: false, reason: k };
  for (const k of ['generation', 'seq', 'geometryVersion', 'seed']) if (!isNonNegInt(e[k])) return { ok: false, reason: k };
  if (!EVENT_KINDS.includes(e.kind)) return { ok: false, reason: 'kind' };
  if (e.from !== undefined && !isPoint(e.from)) return { ok: false, reason: 'from' };
  if (!isPoint(e.to)) return { ok: false, reason: 'to' };
  if (!Number.isFinite(e.durationMs) || e.durationMs < 0) return { ok: false, reason: 'durationMs' };
  if (typeof e.confirmed !== 'boolean') return { ok: false, reason: 'confirmed' };
  return { ok: true };
}

/** The client's event state before any event: no generation adopted, nothing played, no known pointer position. */
export function initialEventState() {
  return { generation: null, seq: -1, position: null };
}

/**
 * Decides what a client does with an event, as a pure function: `{ state, action }`.
 * Drops an older generation or a seq not newer than the last played one; a newer generation cancels the running motion and
 * restarts the sequence. Reduce Motion jumps to `to`; an event older than its durationMs on arrival snaps to its end state;
 * a geometryVersion other than the client's latest frame holds the cursor where it is.
 * AMBIGUOUS: the event carries no time, so `opts.receivedAtMs` (the client's own receive stamp, default nowMs) gives its age.
 * @param {{ generation: number|null, seq: number, position: {x:number,y:number}|null }} state
 * @param {any} event
 * @param {number} nowMs
 * @param {{ reduceMotion?: boolean, geometryVersion?: number, receivedAtMs?: number, bounds?: any }} [opts]
 */
export function acceptEvent(state, event, nowMs, opts = {}) {
  const valid = validateCursorMotionEvent(event);
  if (!valid.ok) return { state, action: { type: 'drop', reason: `invalid:${valid.reason}` } };
  const newer = state.generation === null || event.generation > state.generation;
  if (!newer && event.generation < state.generation) return { state, action: { type: 'drop', reason: 'stale-generation' } };
  if (!newer && event.seq <= state.seq) return { state, action: { type: 'drop', reason: 'stale-seq' } };
  const cancel = newer && state.generation !== null;
  const next = { generation: event.generation, seq: event.seq, position: event.to };
  const base = { cancel };
  if (event.kind === 'hide') return { state: next, action: { type: 'hide', ...base } };
  if (opts.geometryVersion !== undefined && opts.geometryVersion !== event.geometryVersion)
    return { state: { ...next, position: state.position }, action: { type: 'hold', ...base } };
  if (opts.reduceMotion) return { state: next, action: { type: 'jump', to: event.to, ...base } };
  const from = event.from ?? state.position;
  const age = Math.max(0, nowMs - (opts.receivedAtMs ?? nowMs));
  if (age >= event.durationMs || !from) return { state: next, action: { type: 'snap', to: event.to, ...base } };
  const plan = planMove({ from, to: event.to, bounds: opts.bounds, kind: event.kind });
  return { state: next, action: { type: 'play', plan, startOffsetMs: age, ...base } };
}
