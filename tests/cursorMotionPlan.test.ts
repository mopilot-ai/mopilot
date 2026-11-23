// shared/cursorMotionPlan.mjs: the Sky-style cursor motion planner (determinism, path choice, spring timing, scoot envelope) and cursorMotion event acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_TABLES,
  MOTION_CONFIG,
  PLAN_EVENT_VERSION,
  SAMPLE_HZ,
  TIMING,
  acceptEvent,
  choosePath,
  generateCandidates,
  initialEventState,
  pathStats,
  planMove,
  sampleAt,
  scorePath,
  springResponse,
  straightPath,
  validateCursorMotionEvent,
} from '../shared/cursorMotionPlan.mjs';

const BOUNDS = { x: 0, y: 0, width: 2000, height: 1200 };
const P = (x: number, y: number) => ({ x, y });
const plan = (from: { x: number; y: number }, to: { x: number; y: number }, extra: object = {}) =>
  planMove({ from, to, bounds: BOUNDS, ...extra });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test('constants: the recovered MotionConfiguration values', () => {
  assert.equal(MOTION_CONFIG.clickAngle, -44);
  assert.equal(MOTION_CONFIG.candidateCount, 20);
  assert.equal(MOTION_CONFIG.boundsMargin, 20);
  assert.equal(MOTION_CONFIG.startHandle, 0.4196);
  assert.equal(MOTION_CONFIG.endpointHandle, 0.15);
  assert.equal(MOTION_CONFIG.arcSize, 0.2766);
  assert.equal(MOTION_CONFIG.arcFlow, 0.5784);
  assert.equal(MOTION_CONFIG.straightPathDistanceThreshold, 10);
  assert.equal(MOTION_CONFIG.springResponseScaler, 0.9);
  assert.equal(MOTION_CONFIG.springResponseMin, 0.12);
  assert.equal(MOTION_CONFIG.springResponseMax, 2.2);
  assert.equal(MOTION_CONFIG.springDampingFraction, 0.9);
  assert.equal(MOTION_CONFIG.terminalTangentBlendStart, 0.99);
  assert.equal(MOTION_CONFIG.scootDistanceThreshold, 196);
  assert.equal(SAMPLE_HZ, 120);
  assert.equal(PLAN_EVENT_VERSION, 1);
  assert.ok(Object.isFrozen(MOTION_CONFIG));
});

test('candidates: 20 per move, the start fixed and the end exact, the favoured side first, honouring a smaller candidateCount', () => {
  const from = P(100, 100);
  const to = P(800, 400);
  const c = generateCandidates(from, to);
  assert.equal(c.length, 20);
  for (const path of c) {
    assert.deepEqual(path.segments[0][0], from);
    assert.deepEqual(path.segments.at(-1)![3], to);
  }
  assert.equal(c.filter((x) => x.segments.length === 1).length, 2);
  assert.equal(c.filter((x) => x.segments.length === 2).length, 18);
  assert.equal(generateCandidates(from, to, { ...MOTION_CONFIG, candidateCount: 5 }).length, 5);
  // the favoured side is the one whose start tangent does not run against the pointer heading, so it scores lower on that term
  const dir = (path: any) => {
    const [a, b] = path.segments[0];
    return P(b.x - a.x, b.y - a.y);
  };
  const s0 = scorePath(pathStats(c[0], BOUNDS), dist(from, to), dir(c[0]));
  const s1 = scorePath(pathStats(c[1], BOUNDS), dist(from, to), dir(c[1]));
  assert.notEqual(s0, s1);
  // a chord whose cross with the heading is negative favours the other side first
  const left = generateCandidates(P(800, 400), P(100, 100));
  assert.equal(left.length, 20);
  assert.equal(
    (CANDIDATE_TABLES.arcScales as readonly number[]).length * (CANDIDATE_TABLES.flowScales as readonly number[]).length * 2 + 2,
    20,
  );
});

test('pathStats: length, turning and the bounds margin', () => {
  const s = pathStats(straightPath(P(0, 0), P(300, 400)), BOUNDS);
  assert.ok(Math.abs(s.L - 500) < 1e-6);
  assert.ok(s.S2 < 1e-12 && s.Smax < 1e-9 && s.Sabs < 1e-9);
  assert.equal(s.inBounds, false); // the start at (0,0) is inside the 20 px margin
  assert.equal(pathStats(straightPath(P(100, 100), P(300, 400)), BOUNDS).inBounds, true);
  assert.equal(pathStats(straightPath(P(100, 100), P(300, 400))).inBounds, true); // no bounds: everything counts as inside
  const curved = pathStats(generateCandidates(P(100, 100), P(900, 300))[2], BOUNDS);
  assert.ok(curved.L > 825 && curved.Sabs > 0.5 && curved.S2 > 0 && curved.Smax > 0);
  // a path that doubles back by more than pi exercises the heading wrap in both directions
  const wrapPos = pathStats({ segments: [[P(0, 0), P(100, 0), P(-100, 1), P(0, 1)]], isStraight: false }, undefined);
  const wrapNeg = pathStats({ segments: [[P(0, 0), P(100, 0), P(-100, -1), P(0, -1)]], isStraight: false }, undefined);
  assert.ok(wrapPos.Smax <= Math.PI && wrapNeg.Smax <= Math.PI);
  // zero-length chords are skipped
  const still = pathStats({ segments: [[P(5, 5), P(5, 5), P(5, 5), P(5, 5)]], isStraight: false }, undefined);
  assert.ok(still.L < 1e-9 && still.Sabs === 0);
  assert.equal(generateCandidates(P(5, 5), P(5, 5)).length, 20); // a zero chord falls back to the +x direction
});

test('choosePath: 20 candidates scored, lowest in-bounds wins, ties keep the first, out-of-bounds everywhere falls back to all', () => {
  const open = choosePath(P(300, 300), P(1200, 700), BOUNDS);
  assert.equal(open.count, 20);
  assert.ok(open.index >= 0 && open.index < 20);
  assert.equal(open.stats.inBounds, true);
  // near the top edge the favoured single cubic would leave the margin, so another candidate has to win
  const edge = choosePath(P(100, 1160), P(900, 1160), BOUNDS);
  assert.equal(edge.stats.inBounds, true);
  assert.ok(edge.index > 0);
  const all = generateCandidates(P(100, 1160), P(900, 1160));
  const best = all.map((p, i) => ({ i, s: pathStats(p, BOUNDS) }));
  assert.ok(best.some((b) => !b.s.inBounds));
  // nothing fits in a tiny screen: all candidates stay in the pool and the lowest score still wins
  const tiny = choosePath(P(110, 110), P(300, 300), { x: 100, y: 100, width: 220, height: 220 });
  assert.equal(tiny.stats.inBounds, false);
  assert.equal(tiny.count, 20);
});

test('springResponse: clamped to [min, max], slower for long, curved, backtracking paths, straight is faster', () => {
  const base = { L: 100, S2: 0, Smax: 0, Sabs: 0, backtrack: 0 };
  const short = springResponse(base, 100, true);
  assert.ok(Math.abs(short - 0.9 * 0.42) < 1e-9);
  const long = springResponse({ ...base, L: 1200 }, 1000, false);
  assert.ok(long > short);
  const curvy = springResponse({ L: 1200, S2: 2, Smax: 1, Sabs: 6, backtrack: 1 }, 800, false);
  assert.ok(curvy > long);
  assert.equal(springResponse(base, 100, true, { ...MOTION_CONFIG, springResponseMin: 5, springResponseMax: 6 }), 5);
  assert.equal(springResponse(base, 100, true, { ...MOTION_CONFIG, springResponseMin: 0.01, springResponseMax: 0.02 }), 0.02);
  // stats with no backtrack field read as zero
  assert.equal(springResponse({ L: 100, S2: 0, Smax: 0, Sabs: 0 } as any, 100, true), short);
});

test('planMove: deterministic and golden for the same input', () => {
  const a = plan(P(100, 100), P(900, 500));
  const b = plan(P(100, 100), P(900, 500));
  assert.deepEqual(a, b);
  assert.equal(a.mode, 'arc');
  assert.equal(a.samples[0].t, 0);
  assert.ok(Math.abs(a.samples[1].t - 1000 / 120) < 1e-9);
  // golden anchors: any change to the constants or formulas moves these on purpose
  assert.ok(Math.abs(a.response - 0.61944) < 1e-4, `response ${a.response}`);
  assert.equal(a.samples.length, Math.round((a.durationMs * 120) / 1000) + 1);
  assert.ok(a.durationMs > 450 && a.durationMs < 1000, `duration ${a.durationMs}`);
});

test('planMove: endpoints are exact, progress and position never go backwards', () => {
  for (const [from, to] of [
    [P(100, 100), P(900, 500)],
    [P(1500, 900), P(200, 200)],
    [P(300, 300), P(300, 1000)],
    [P(100, 100), P(180, 140)],
  ]) {
    const p = plan(from, to);
    assert.deepEqual([p.samples[0].x, p.samples[0].y], [from.x, from.y]);
    assert.deepEqual([p.samples.at(-1)!.x, p.samples.at(-1)!.y], [to.x, to.y]);
    assert.deepEqual(
      { s: p.samples.at(-1)!.scaleX, y: p.samples.at(-1)!.scaleY, v: p.samples.at(-1)!.pivotX, r: p.samples.at(-1)!.tiltDeg },
      { s: 1, y: 1, v: 0.5, r: 0 },
    );
    for (let i = 1; i < p.samples.length; i++) assert.ok(p.samples[i].progress >= p.samples[i - 1].progress - 1e-12);
    assert.ok(p.arrivalIndex >= 0 && p.arrivalIndex < p.samples.length);
    // the click moment is when the tip is within 3.157 px or past 99.5% of the way
    const at = p.samples[p.arrivalIndex];
    assert.ok(dist(at, to) <= TIMING.closeEnoughDistance + 1e-9 || at.progress >= TIMING.closeEnoughProgress);
  }
});

test('planMove: D <= 10 is a straight path, D <= 196 the scoot line, beyond that an arc chosen among 20', () => {
  const straight = plan(P(500, 500), P(506, 508));
  assert.equal(straight.mode, 'straight');
  assert.equal(straight.selection, null);
  for (const s of straight.samples) {
    const cross = Math.abs((s.x - 500) * 8 - (s.y - 500) * 6);
    assert.ok(cross < 1e-6); // every sample lies on the chord
  }
  const scoot = plan(P(500, 500), P(500, 650));
  assert.equal(scoot.mode, 'scoot');
  assert.equal(scoot.response, MOTION_CONFIG.scootPositionResponse);
  for (const s of scoot.samples) assert.ok(Math.abs(s.x - 500) < 1e-6);
  const arc = plan(P(300, 300), P(1200, 700));
  assert.equal(arc.mode, 'arc');
  assert.equal(arc.selection!.count, 20);
  assert.ok(arc.selection!.index >= 0 && arc.selection!.index < 20);
  assert.ok(arc.response >= MOTION_CONFIG.springResponseMin && arc.response <= MOTION_CONFIG.springResponseMax);
  // at exactly the thresholds the nearer mode applies
  assert.equal(plan(P(0, 100), P(10, 100)).mode, 'straight');
  assert.equal(plan(P(100, 100), P(296, 100)).mode, 'scoot');
  assert.equal(plan(P(100, 100), P(297, 100)).mode, 'arc');
  // the arc leaves the chord, but only the winning candidate's way
  const off = arc.samples.some((s) => Math.abs((s.x - 300) * 400 - (s.y - 300) * 900) / Math.hypot(900, 400) > 5);
  assert.ok(off);
});

test('planMove: near an edge another candidate wins and the path keeps its margin', () => {
  const p = planMove({ from: P(100, 1160), to: P(900, 1160), bounds: BOUNDS });
  assert.ok(p.selection!.index > 0);
  for (const s of p.samples) assert.ok(s.y <= 1200 - 20 + 1, `y ${s.y}`); // flattened path vs sampled spring points
});

test('planMove: duration grows with distance within the clamp, and never passes the cap', () => {
  const durations = [250, 400, 700, 1100, 1700].map((d) => plan(P(100, 100), P(100 + d, 100)).durationMs);
  for (let i = 1; i < durations.length; i++) assert.ok(durations[i] >= durations[i - 1] - 8.4, durations.join());
  const max = Math.max(...durations);
  assert.ok(max <= TIMING.maxPlanMs);
  assert.ok(Math.min(...durations) >= MOTION_CONFIG.springResponseMin * 1000 * 0.8);
  // a spring that cannot settle is cut at the cap and ends exactly at the target
  const slow = planMove(
    { from: P(100, 100), to: P(900, 100), bounds: BOUNDS },
    { ...MOTION_CONFIG, springResponseMin: 50, springResponseMax: 50 },
  );
  assert.ok(slow.durationMs >= TIMING.maxPlanMs && slow.durationMs < TIMING.maxPlanMs + 10);
  assert.deepEqual([slow.samples.at(-1)!.x, slow.samples.at(-1)!.y], [900, 100]);
});

test('planMove: sub-pixel moves, hide and invalid input', () => {
  const same = plan(P(10, 10), P(10.2, 10));
  assert.equal(same.mode, 'jump');
  assert.equal(same.durationMs, 0);
  assert.equal(same.samples.length, 1);
  assert.equal(same.arrivalIndex, 0);
  const hide = plan(P(0, 0), P(900, 900), { kind: 'hide' });
  assert.equal(hide.mode, 'jump');
  assert.equal(plan(P(0, 0), P(900, 900), { kind: 'drag' }).kind, 'drag');
  assert.equal(planMove({ from: P(0, 0), to: P(300, 0) }).mode, 'arc'); // no bounds: the whole plane is allowed
  assert.throws(() => planMove({ from: P(0, 0), to: P(NaN, 1) } as any), TypeError);
  assert.throws(() => planMove(undefined as any), TypeError);
  assert.throws(() => planMove({ from: null, to: P(1, 1) } as any), TypeError);
  assert.throws(() => planMove({ from: P(0, 0), to: P(5, 5), kind: 'wave' }), RangeError);
});

test('scoot envelope: stretch and squash rise early and fall to rest, tilt follows the heading and is bounded', () => {
  const p = plan(P(200, 600), P(1400, 600));
  const mid = p.samples.slice(0, p.arrivalIndex);
  const peakX = Math.max(...mid.map((s) => s.scaleX));
  assert.ok(peakX > 1.05 && peakX <= 1 + MOTION_CONFIG.scootStretchXAmount + 1e-9);
  assert.ok(Math.min(...mid.map((s) => s.scaleY)) < 0.97);
  assert.ok(Math.min(...p.samples.map((s) => s.scaleY)) >= 1 - MOTION_CONFIG.scootSquashYAmount - 1e-9);
  assert.ok(Math.max(...p.samples.map((s) => Math.abs(s.tiltDeg))) <= MOTION_CONFIG.scootRotationMax + 1e-9);
  // moving right tilts one way, moving left the other
  const right = plan(P(200, 600), P(1400, 600));
  const left = plan(P(1400, 600), P(200, 600));
  const tilt = (q: any) => q.samples.reduce((a: number, s: any) => (Math.abs(s.tiltDeg) > Math.abs(a) ? s.tiltDeg : a), 0);
  assert.ok(tilt(right) > 0 && tilt(left) < 0);
  // the pivot flips towards the far side for leftwards moves
  assert.ok(Math.max(...left.samples.map((s) => s.pivotX)) > 0.55);
  assert.ok(Math.max(...right.samples.map((s) => s.pivotX)) <= 0.5 + 1e-9);
  // downwards moves tilt via the vertical term
  assert.ok(tilt(plan(P(600, 100), P(600, 1100))) < 0);
});

test('sampleAt: interpolates between samples, clamps outside, and reads a one-sample plan', () => {
  const p = plan(P(100, 100), P(900, 500));
  assert.deepEqual(sampleAt(p, -50), p.samples[0]);
  assert.deepEqual(sampleAt(p, 0), p.samples[0]);
  assert.deepEqual(sampleAt(p, p.durationMs + 1000), p.samples.at(-1));
  assert.deepEqual(sampleAt(p, p.durationMs), p.samples.at(-1));
  const t = (p.samples[3].t + p.samples[4].t) / 2;
  const m = sampleAt(p, t);
  assert.ok(Math.abs(m.x - (p.samples[3].x + p.samples[4].x) / 2) < 1e-9);
  assert.ok(Math.abs(m.t - t) < 1e-9);
  const one = plan(P(1, 1), P(1, 1));
  assert.deepEqual(sampleAt(one, 100), one.samples[0]);
});

// ---- events ----

const ev = (over: object = {}) => ({
  v: PLAN_EVENT_VERSION,
  host: 'local',
  chatId: 'chat-1',
  target: 'tab-1',
  generation: 1,
  seq: 1,
  kind: 'move',
  from: P(100, 100),
  to: P(900, 500),
  geometryVersion: 7,
  durationMs: 600,
  seed: 42,
  confirmed: false,
  ...over,
});

test('validateCursorMotionEvent: accepts the draft shape and names the first bad field', () => {
  assert.deepEqual(validateCursorMotionEvent(ev()), { ok: true });
  assert.deepEqual(validateCursorMotionEvent(ev({ from: undefined })), { ok: true });
  const bad = (over: object) => (validateCursorMotionEvent(ev(over)) as { reason: string }).reason;
  assert.equal(bad({ v: 2 }), 'version');
  assert.equal(bad({ host: '' }), 'host');
  assert.equal(bad({ chatId: 3 }), 'chatId');
  assert.equal(bad({ target: undefined }), 'target');
  assert.equal(bad({ generation: -1 }), 'generation');
  assert.equal(bad({ seq: 1.5 }), 'seq');
  assert.equal(bad({ geometryVersion: 'x' }), 'geometryVersion');
  assert.equal(bad({ seed: NaN }), 'seed');
  assert.equal(bad({ kind: 'wave' }), 'kind');
  assert.equal(bad({ from: { x: 1 } }), 'from');
  assert.equal(bad({ to: null }), 'to');
  assert.equal(bad({ durationMs: -1 }), 'durationMs');
  assert.equal(bad({ confirmed: 'yes' }), 'confirmed');
  assert.deepEqual(validateCursorMotionEvent(null), { ok: false, reason: 'not-an-object' });
  assert.deepEqual(validateCursorMotionEvent('x'), { ok: false, reason: 'not-an-object' });
});

test('acceptEvent: plays a fresh event from its own `from` with a startOffset of the time since arrival', () => {
  const r = acceptEvent(initialEventState(), ev(), 1000, { receivedAtMs: 900, bounds: BOUNDS });
  assert.equal(r.action.type, 'play');
  assert.equal((r.action as any).startOffsetMs, 100);
  assert.equal((r.action as any).cancel, false);
  assert.equal((r.action as any).plan.mode, 'arc');
  assert.deepEqual(r.state, { generation: 1, seq: 1, position: P(900, 500) });
  // the next event with no `from` starts where the last one ended
  const next = acceptEvent(r.state, ev({ seq: 2, from: undefined, to: P(1000, 700) }), 2000);
  assert.equal(next.action.type, 'play');
  assert.deepEqual((next.action as any).plan.samples[0], { ...(next.action as any).plan.samples[0], x: 900, y: 500 });
  assert.equal((next.action as any).startOffsetMs, 0);
});

test('acceptEvent: drops invalid events, stale generations and stale or repeated seqs without changing state', () => {
  const s0 = acceptEvent(initialEventState(), ev({ generation: 3, seq: 5 }), 0).state;
  const keep = (e: unknown, reason: string) => {
    const r = acceptEvent(s0, e, 0);
    assert.deepEqual(r.action, { type: 'drop', reason });
    assert.equal(r.state, s0);
  };
  keep(ev({ generation: 2, seq: 99 }), 'stale-generation');
  keep(ev({ generation: 3, seq: 5 }), 'stale-seq');
  keep(ev({ generation: 3, seq: 4 }), 'stale-seq');
  keep(ev({ v: 9 }), 'invalid:version');
  keep(null, 'invalid:not-an-object');
  assert.equal(acceptEvent(s0, ev({ generation: 3, seq: 6 }), 0).action.type, 'play');
});

test('acceptEvent: a newer generation cancels the running motion and restarts seq', () => {
  const s0 = acceptEvent(initialEventState(), ev({ generation: 1, seq: 50 }), 0).state;
  const r = acceptEvent(s0, ev({ generation: 2, seq: 0 }), 0);
  assert.equal((r.action as any).cancel, true);
  assert.deepEqual(r.state, { generation: 2, seq: 0, position: P(900, 500) });
  assert.equal(acceptEvent(r.state, ev({ generation: 2, seq: 1 }), 0).action.type, 'play');
});

test('acceptEvent: an event older than its duration on arrival snaps to its end; an unknown start also snaps', () => {
  const late = acceptEvent(initialEventState(), ev(), 5000, { receivedAtMs: 4300 });
  assert.deepEqual(late.action, { type: 'snap', to: P(900, 500), cancel: false });
  const exact = acceptEvent(initialEventState(), ev(), 5000, { receivedAtMs: 4400 });
  assert.equal(exact.action.type, 'snap');
  const justUnder = acceptEvent(initialEventState(), ev(), 5000, { receivedAtMs: 4401 });
  assert.equal(justUnder.action.type, 'play');
  const noStart = acceptEvent(initialEventState(), ev({ from: undefined }), 0);
  assert.equal(noStart.action.type, 'snap');
  // a receive stamp in the future never makes the age negative
  assert.equal((acceptEvent(initialEventState(), ev(), 0, { receivedAtMs: 500 }).action as any).startOffsetMs, 0);
});

test('acceptEvent: Reduce Motion jumps to the destination even for a fresh event', () => {
  const r = acceptEvent(initialEventState(), ev(), 0, { reduceMotion: true });
  assert.deepEqual(r.action, { type: 'jump', to: P(900, 500), cancel: false });
  assert.deepEqual(r.state.position, P(900, 500));
});

test('acceptEvent: a geometry mismatch holds the cursor where it was; a match plays', () => {
  const s = { generation: 1, seq: 0, position: P(10, 20) };
  const held = acceptEvent(s, ev(), 0, { geometryVersion: 8 });
  assert.deepEqual(held.action, { type: 'hold', cancel: false });
  assert.deepEqual(held.state, { generation: 1, seq: 1, position: P(10, 20) });
  assert.equal(acceptEvent(s, ev(), 0, { geometryVersion: 7 }).action.type, 'play');
});

test('acceptEvent: a confirmed click carries no ring (Sky shows none); hide hides', () => {
  const act = (e: object) => acceptEvent(initialEventState(), ev(e), 0, { reduceMotion: true }).action as any;
  assert.deepEqual(act({ kind: 'click', confirmed: true }), { type: 'jump', to: P(900, 500), cancel: false });
  assert.equal('ring' in act({ kind: 'click', confirmed: true }), false);
  const h = acceptEvent(initialEventState(), ev({ kind: 'hide', confirmed: true }), 0);
  assert.deepEqual(h.action, { type: 'hide', cancel: false });
});
