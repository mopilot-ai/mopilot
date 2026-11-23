// shared/cursorApproach.mjs: the observed Sky cursor plan (start on the line back, straight critically damped glide, press, vanish).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_HZ, sampleAt } from '../shared/cursorMotionPlan.mjs';
import { OBSERVED, OBSERVED_CODEX_IAB, planApproach } from '../shared/cursorApproach.mjs';

const P = (x: number, y: number) => ({ x, y });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/* -- planApproach: the observed Sky cursor (#3810) ---------------------------------------------------------------------- */
const TO = P(400, 300);
const omega0 = (2 * Math.PI) / OBSERVED.response;
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

test('planApproach: starts on the line back to the previous point, clipped to 140 pt as a whole vector (direction kept)', () => {
  const far = planApproach({ from: P(1200, 100), to: TO });
  assert.deepEqual(far.start, P(540, 265));
  // the clip scales the whole vector: a far diagonal's start lies on the line back to the previous point (a per-axis clip put it 66 pt off for 400 pt)
  for (const [fx, fy] of [
    [1200, 100],
    [800, 700],
    [0, 650],
    [3000, 3000],
    [-900, 1500],
  ]) {
    const s = planApproach({ from: P(fx, fy), to: TO }).start;
    const back = { x: fx - TO.x, y: fy - TO.y };
    const off = { x: s.x - TO.x, y: s.y - TO.y };
    const lineDistance = Math.abs(off.x * back.y - off.y * back.x) / Math.hypot(back.x, back.y);
    assert.ok(lineDistance < 0.5, `start ${lineDistance} pt off the line from (${fx}, ${fy})`);
    assert.ok(off.x * back.x + off.y * back.y > 0, 'on the side of the previous point');
    near(Math.max(Math.abs(off.x), Math.abs(off.y)), 140, 1e-9);
  }
  // a straight line back: the direction is exact, the start about 140 pt away
  assert.deepEqual(planApproach({ from: P(1400, 300), to: TO }).start, P(540, 300));
  // closer than the clip: it starts on the previous point (observed in d100)
  assert.deepEqual(planApproach({ from: P(450, 260), to: TO }).start, P(450, 260));
  assert.ok(planApproach({ from: P(450, 260), to: TO }).distance < 140);
  // the longest start is the 45 degree diagonal (largest component 140)
  near(planApproach({ from: P(700, 600), to: TO }).distance, 140 * Math.SQRT2, 1e-9);
});

test('planApproach: no previous point, or one on the target, starts from the lower left, always the same', () => {
  const a = planApproach({ to: TO });
  assert.deepEqual(a.start, P(301, 399));
  near(a.distance, 140, 0.1);
  assert.deepEqual(planApproach({ from: null, to: TO }).start, a.start);
  assert.deepEqual(planApproach({ from: TO, to: TO }).start, a.start);
  assert.deepEqual(planApproach({ from: P(400.2, 300.2), to: TO }).start, a.start);
  assert.deepEqual(planApproach({ from: { x: NaN, y: 1 } as any, to: TO }).start, a.start);
  assert.deepEqual(OBSERVED.defaultOffset, { x: -99, y: 99 });
});

test('planApproach: a critically damped spring of response 0.25 s on a straight path, settled in 250-350 ms', () => {
  const p = planApproach({ from: P(1000, 900), to: TO });
  assert.ok(p.durationMs >= 250 && p.durationMs <= 350, `duration ${p.durationMs}`);
  // golden: the diagonal clip (140, 140) stops at 314 ms (233 ms to within 4 pt)
  near(p.durationMs, 313.3, 8.4);
  assert.ok(p.distance * (1 + omega0 * 0.2333) * Math.exp(-omega0 * 0.2333) <= 4.1);
  const omega = omega0;
  for (const s of p.samples.filter((x) => x.t <= p.durationMs && x.t > 0 && x.progress < 1)) {
    const k = 1 - (1 + omega * (s.t / 1000)) * Math.exp(-omega * (s.t / 1000));
    near(s.progress, k);
    // straight: every sample is on the chord from start to target
    const cross = (s.x - p.start.x) * (TO.y - p.start.y) - (s.y - p.start.y) * (TO.x - p.start.x);
    near(cross, 0, 1e-6);
  }
  // monotone, no overshoot, ends on the target
  assert.ok(p.samples.every((s, i) => i === 0 || s.progress >= p.samples[i - 1].progress));
  assert.ok(p.samples.every((s) => s.progress <= 1));
  assert.deepEqual([p.samples[0].x, p.samples[0].y, p.samples[0].progress], [p.start.x, p.start.y, 0]);
  const arrival = p.samples.find((s) => s.t >= p.durationMs)!;
  assert.deepEqual([arrival.x, arrival.y, arrival.progress], [TO.x, TO.y, 1]);
  // the step before arrival is still more than 0.85 pt away
  const before = p.samples[Math.round((p.durationMs * SAMPLE_HZ) / 1000) - 1];
  assert.ok(dist(before, TO) > OBSERVED.settleDistance);
  // peak speed at 7-19% of the travel time (observed), then a long deceleration
  const speeds = p.samples.slice(1).map((s, i) => dist(s, p.samples[i]));
  const peakAt = (speeds.indexOf(Math.max(...speeds)) * 1000) / SAMPLE_HZ / p.durationMs;
  assert.ok(peakAt >= 0.07 && peakAt <= 0.19, `peak at ${peakAt}`);
  // a shorter start settles sooner
  const short = planApproach({ from: P(450, 300), to: TO });
  assert.ok(short.durationMs < p.durationMs);
  // sampled at 120 Hz
  p.samples.forEach((s, i) => near(s.t, (i * 1000) / SAMPLE_HZ));
});

test('planApproach: arrow, hover, disc at the click, gone within one frame after it', () => {
  const p = planApproach({ from: P(1200, 300), to: TO });
  assert.equal(p.hoverMs, 45);
  assert.equal(p.hideAfterClickMs, 6);
  near(p.pressAtMs, p.durationMs + p.hoverMs);
  near(p.totalMs, p.pressAtMs + p.hideAfterClickMs);
  assert.ok(p.hideAfterClickMs < 1000 / 60);
  assert.ok(p.samples.every((s) => s.state === (s.t >= p.totalMs ? 'hidden' : s.t >= p.pressAtMs ? 'disc' : 'arrow')));
  assert.deepEqual([p.samples[0].state, p.samples.at(-1)!.state], ['arrow', 'hidden']);
  // the press lasts less than a frame, so the exact changes are in the timeline
  assert.deepEqual(p.timeline, [
    { t: 0, state: 'arrow' },
    { t: p.pressAtMs, state: 'disc' },
    { t: p.totalMs, state: 'hidden' },
  ]);
  // after arrival the cursor holds on the target
  for (const s of p.samples.filter((x) => x.t >= p.durationMs)) assert.deepEqual([s.x, s.y], [TO.x, TO.y]);
  // sampleAt reads the state label from the earlier sample and interpolates the numbers
  assert.equal(sampleAt(p, p.pressAtMs - 3).state, 'arrow');
  assert.equal(sampleAt(p, 0).state, 'arrow');
  near(sampleAt(p, 4.1665).progress, p.samples[1].progress / 2 + p.samples[0].progress / 2, 1e-3);
  assert.equal(sampleAt(p, p.totalMs + 500).state, 'hidden');
});

test('planApproach: reduced motion jumps, with no glide', () => {
  const p = planApproach({ from: P(1200, 100), to: TO, reducedMotion: true });
  assert.deepEqual(p.start, TO);
  assert.equal(p.durationMs, 0);
  assert.equal(p.distance, 0);
  assert.ok(p.samples.every((s) => s.x === TO.x && s.y === TO.y && s.progress === 1));
  assert.equal(p.samples[0].state, 'arrow');
  near(p.pressAtMs, p.hoverMs);
  assert.equal(p.samples.at(-1)!.state, 'hidden');
});

test('planApproach: bounds keep the start inside along the same line; deterministic; bad input throws', () => {
  const b = { x: 0, y: 0, width: 500, height: 400 };
  // up-left of a point near the corner would start outside: it is pulled back along the line
  const p = planApproach({ from: P(-900, -900), to: P(60, 40), bounds: b });
  assert.ok(p.start.x >= 0 && p.start.y >= 0);
  near((p.start.x - 60) * 940, (p.start.y - 40) * 960, 1e-6); // still on the line back to the previous point
  // below, to the right, and an axis-aligned offset (a zero component)
  const q = planApproach({ from: P(5000, 5000), to: P(450, 350), bounds: b });
  assert.ok(q.start.x <= 500 && q.start.y <= 400);
  const r = planApproach({ from: P(5000, 300), to: P(450, 300), bounds: b });
  assert.deepEqual(r.start, P(500, 300));
  assert.deepEqual(planApproach({ from: P(5000, 300), to: P(450, 300), bounds: b }), r);
  // the target on the edge: nothing left to glide
  const e = planApproach({ from: P(-900, 300), to: P(0, 300), bounds: b });
  assert.equal(e.distance, 0);
  assert.equal(e.durationMs, 0);
  // inside already: unchanged
  assert.deepEqual(planApproach({ from: P(900, 300), to: P(300, 300), bounds: b }).start, P(440, 300));
  assert.throws(() => planApproach({ to: { x: NaN, y: 0 } }), TypeError);
  assert.throws(() => planApproach(undefined as any), TypeError);
});

test('planApproach: a profile overrides the Sky defaults for one call and leaves OBSERVED alone', () => {
  const sky = planApproach({ from: P(1400, 300), to: TO });
  const iab = planApproach({ from: P(1400, 300), to: TO, profile: OBSERVED_CODEX_IAB });
  // same start (both clip at 140), a faster spring, a longer hover and the 287 ms linger after the click
  assert.deepEqual(iab.start, sky.start);
  assert.ok(iab.durationMs < sky.durationMs);
  assert.equal(iab.hoverMs, OBSERVED_CODEX_IAB.hoverMs);
  assert.equal(iab.hideAfterClickMs, 287);
  near(iab.totalMs, iab.durationMs + 150 + 287);
  assert.equal(iab.samples.at(-1)?.state, 'hidden');
  // a partial profile keeps the remaining Sky values, a smaller startClip shortens the approach
  const short = planApproach({ from: P(1400, 300), to: TO, profile: { startClip: 60 } });
  assert.deepEqual(short.start, P(460, 300));
  assert.equal(short.hoverMs, OBSERVED.hoverMs);
  assert.equal(OBSERVED.response, 0.25);
  assert.equal(planApproach({ from: P(1400, 300), to: TO, profile: null }).durationMs, sky.durationMs);
});
