// Motion bench frame metrics (bench/lib/motion/frames.mjs, fit.mjs, metrics.mjs) on synthetic frame sequences whose timings and curves are known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestShift, cells, changeSeries, diff, parseFrames, PIXEL_DELTA, profile } from '../bench/lib/motion/frames.mjs';
import { bezierAt, fitBezier, minimize, nearest, progress, rmse } from '../bench/lib/motion/fit.mjs';
import {
  cadence,
  captureMs,
  deadAir,
  droppedFrames,
  feedback,
  firstChange,
  layoutShift,
  MIN_MASS,
  REFRESH_MS,
  runs,
  settle,
  timeTo,
  transition,
} from '../bench/lib/motion/metrics.mjs';
import { drawVideo, framesBuffer, synthVideo } from './support/motionFrames.ts';

const synth = synthVideo(4);

test('parseFrames reads decode.swift output and refuses broken files', () => {
  const v = parseFrames(framesBuffer(synth));
  assert.equal(v.frames.length, 268);
  assert.deepEqual([v.width, v.height, v.scale, v.source], [160, 100, 4, [640, 400]]);
  assert.equal(v.frames[1].t, synth.frames[1].t);
  assert.deepEqual([...v.frames[100].px.slice(0, 8)], [...synth.frames[100].px.slice(0, 8)]);
  assert.deepEqual(
    parseFrames(framesBuffer({ ...synth, frames: [] }, { source: undefined })).source,
    [640, 400],
    'source defaults to the scaled size',
  );
  assert.throws(() => parseFrames(Buffer.from('{"width":1}')), /no header line/);
  assert.throws(() => parseFrames(Buffer.from('{"width":0,"height":1,"scale":1}\n')), /bad width/);
  assert.throws(() => parseFrames(Buffer.from('{"width":2,"height":1,"scale":1.5}\n')), /bad scale/);
  assert.throws(() => parseFrames(Buffer.concat([framesBuffer(synth), Buffer.from([1, 2])])), /truncated: 2 bytes after frame 268/);
});

test('cells, diff, changeSeries and profile read a region in source pixels', () => {
  assert.deepEqual(cells(synth, [-10, 2, 30, 1000]), { x0: 0, y0: 0, x1: 5, y1: 100 });
  assert.throws(() => cells(synth, [700, 0, 10, 10]), /outside the 640x400 recording/);
  const a = new Uint8Array(160 * 100);
  const b = a.slice();
  b[0] = 100;
  b[1] = PIXEL_DELTA;
  assert.deepEqual(diff(synth, a, b, [0, 0, 8, 4]), { d: (100 + PIXEL_DELTA) / 2, n: 16, m: 1600 });
  const series = changeSeries(synth, [0, 0, 640, 80]);
  assert.deepEqual(series[0], { t: 0, d: 0, n: 0, m: 0 });
  assert.equal(
    series.findIndex((s) => s.n > 0),
    30,
    'the trigger appears at 0.5 s',
  );
  const row = profile(synth, synth.frames[0].px, [0, 340, 640, 20], 'x');
  assert.equal(row.length, 160);
  assert.equal(row[10], 180);
  const col = profile(synth, synth.frames[0].px, [0, 330, 640, 40], 'y');
  assert.equal(col.length, 11, 'a region edge inside a cell takes the whole cell');
});

test('bestShift lines profiles up, counting what moved out of view, preferring the smaller shift', () => {
  const box = (at: number) => Float64Array.from({ length: 20 }, (_, k) => (k >= at && k < at + 3 ? 9 : 0));
  assert.equal(bestShift(box(2), box(12)), 10);
  assert.equal(bestShift(box(12), box(2)), -10);
  assert.equal(bestShift(box(2), box(12), 5), 0, 'no shift within the limit lines the boxes up: none is preferred');
  assert.equal(bestShift(new Float64Array(5), new Float64Array(5)), 0);
});

test('bezierAt, rmse and minimize', () => {
  assert.ok(Math.abs(bezierAt([0.25, 0.1, 0.25, 1], 0)) < 1e-9);
  assert.ok(Math.abs(bezierAt([0.25, 0.1, 0.25, 1], 1) - 1) < 1e-9);
  assert.ok(Math.abs(bezierAt([0, 0, 1, 1], 0.3) - 0.3) < 1e-6, 'linear');
  assert.equal(rmse([{ u: 0.5, p: 0.5 }], [0, 0, 1, 1]) < 1e-6, true);
  const r = minimize(([x, y]) => (x - 3) ** 2 + (y + 1) ** 2, [0, 0], 1);
  assert.ok(Math.abs(r.x[0] - 3) < 1e-3 && Math.abs(r.x[1] + 1) < 1e-3);
  const flat = minimize(([x]) => Math.abs(x), [0], 0.5, 30);
  assert.ok(Math.abs(flat.x[0]) < 1e-3, 'shrinks onto a kink');
});

test('fitBezier recovers a curve from its samples; nearest ranks a palette', () => {
  const points = Array.from({ length: 21 }, (_, i) => ({ u: i / 20, p: bezierAt([0.32, 0.72, 0, 1], i / 20) }));
  const fit = fitBezier(points);
  assert.ok(fit.rmse < 0.01, `rmse ${fit.rmse}`);
  assert.ok(fit.curve.every((v) => Math.round(v * 1000) / 1000 === v));
  const over = Array.from({ length: 21 }, (_, i) => ({ u: i / 20, p: bezierAt([0.34, 1.56, 0.64, 1], i / 20) }));
  assert.ok(fitBezier(over).curve[1] > 1, 'an overshoot keeps its y above 1');
  assert.throws(() => fitBezier([{ u: 0, p: 0 }]), /at least two points/);
  assert.deepEqual(
    nearest(points, { b: [0.32, 0.72, 0, 1], a: [0.32, 0.72, 0, 1], linear: [0, 0, 1, 1] }).map((n) => n.name),
    ['a', 'b', 'linear'],
  );
});

test('progress: a blend for fades, a shift for slides, and nothing when nothing moved', () => {
  const fade = progress(synth, [0, 100, 640, 80], 36, 48, 'blend');
  assert.equal(fade[0].p, 0);
  assert.ok(Math.abs(fade[fade.length - 1].p - 1) < 1e-9);
  assert.ok(fade[3].p > fade[3].u, 'an ease-out runs ahead of time');
  const slide = progress(synth, [0, 200, 640, 60], 60, 76, 'x');
  assert.equal(slide[0].p, 0);
  assert.equal(slide[slide.length - 1].p, 1);
  const tall = drawVideo(40, 80, 2, 10, (t, fill) => fill(0, Math.round(t * 300), 40, 8, 200));
  assert.equal(progress(tall, [0, 0, 40, 80], 0, 9, 'y')[9].p, 1);
  assert.throws(() => progress(synth, [0, 100, 640, 80], 5, 5, 'blend'), /later end frame/);
  assert.throws(() => progress(synth, [0, 100, 640, 80], 1, 3, 'blend'), /nothing moved/);
  assert.throws(() => progress(synth, [0, 100, 640, 80], 1, 3, 'x'), /nothing shifted along x/);
});

test('runs, settle and firstChange find where a region moved', () => {
  const s = (t: number, m: number, d = 0) => ({ t, d, n: m ? 64 : 0, m });
  const series = [s(0, 0), s(10, MIN_MASS), s(20, MIN_MASS), s(200, 0, 0.5), s(400, MIN_MASS), s(410, 0, 0.5), s(420, 0, 0.05)];
  assert.deepEqual(runs(series), [
    { start: 0, end: 20, from: 0, to: 2 },
    { start: 200, end: 400, from: 3, to: 4 },
  ]);
  assert.deepEqual(runs(series, { mergeMs: 500 }), [{ start: 0, end: 400, from: 0, to: 4 }]);
  assert.deepEqual(runs(series, { minMass: MIN_MASS + 1 }), []);
  assert.deepEqual(
    settle(series, { start: 200, end: 400, from: 3, to: 4 }),
    { from: 3, to: 5, start: 200, end: 410 },
    'on through the tail, back no further than a still frame',
  );
  const soft = [s(0, 0, 0.5), s(16, 0, 0.5), s(32, MIN_MASS), s(48, 0, 0.5)];
  assert.deepEqual(
    settle(soft, { start: 16, end: 32, from: 1, to: 2 }),
    { from: 0, to: 3, start: 0, end: 48 },
    'back through an eased start',
  );
  assert.equal(firstChange(series), 10);
  assert.equal(firstChange(series, 300), 400);
  assert.equal(firstChange(series, 500), null);
});

test('feedback, deadAir and cadence on the synthetic recording', () => {
  assert.deepEqual(feedback(synth, { trigger: [0, 0, 640, 80], response: [0, 100, 640, 80] }), { trigger: 500, response: 617, ms: 117 });
  assert.deepEqual(feedback(synth, { trigger: 550, response: [0, 100, 640, 80] }), { trigger: 550, response: 617, ms: 67 });
  assert.deepEqual(feedback(synth, { trigger: [0, 0, 640, 80], after: 600, response: [0, 100, 640, 80] }), {
    trigger: null,
    response: null,
    ms: null,
  });
  assert.deepEqual(feedback(synth, { trigger: 5000, response: [0, 100, 640, 80] }), { trigger: 5000, response: null, ms: null });
  const all = changeSeries(synth, [0, 0, 640, 400]);
  assert.deepEqual(deadAir(all, 1500, 4483), { longestMs: 1600, gaps: [{ from: 2400, to: 4000, ms: 1600 }] });
  assert.deepEqual(deadAir(all, 1500, 4483, 2000).gaps, []);
  assert.deepEqual(cadence(changeSeries(synth, [0, 280, 640, 40])), { updates: 10, medianMs: 100, p90Ms: 100, maxMs: 100, perSecond: 10 });
  assert.deepEqual(cadence(all, 4100, 4200), { updates: 0, medianMs: null, p90Ms: null, maxMs: null, perSecond: null });
  assert.equal(cadence(all, 3900, 4100).perSecond, null, 'one update has no rate');
});

test('droppedFrames counts refreshes skipped while something moved; layoutShift finds jumps', () => {
  const slide = changeSeries(synth, [0, 200, 640, 60]);
  assert.deepEqual(droppedFrames(synth, runs(slide)), { dropped: 2, stalls: [{ at: 1150, ms: 50 }], captureHz: 60 });
  // a recorder capturing at 30 fps: a smooth slide drops nothing, one missed capture still counts
  const slow = drawVideo(400, 40, 2, 30, (t, fill) => fill(Math.round(t * 400), 0, 40, 40, 200), { fps: 30, skip: [15] });
  const slowRuns = runs(changeSeries(slow, [0, 0, 400, 40]));
  assert.ok(Math.abs(captureMs(slow, slowRuns) - 1000 / 30) < 1e-9);
  assert.deepEqual(droppedFrames(slow, slowRuns), { dropped: 1, stalls: [{ at: 467, ms: 67 }], captureHz: 30 });
  assert.equal(captureMs(slow, []), REFRESH_MS, 'no motion: one 60 Hz refresh');
  assert.deepEqual(droppedFrames(synth, runs(slide), 100).dropped, 0, 'a slower display skips nothing');
  assert.deepEqual(layoutShift(synth, [0, 330, 640, 70]), { shifts: [{ at: 4000, dy: 20 }], totalPx: 20 });
  assert.deepEqual(layoutShift(synth, [0, 330, 640, 70], 8).shifts, [{ at: 4000, dy: 8 }], 'capped at maxPx');
});

test('timeTo interpolates when progress crossed a level', () => {
  const pts = [
    { u: 0, p: 0 },
    { u: 0.5, p: 0.5 },
    { u: 0.5, p: 0.5 },
    { u: 1, p: 1 },
  ];
  assert.equal(timeTo(pts, 0.75, 200), 150);
  assert.equal(timeTo(pts, 0.5, 200), 100);
  assert.equal(
    timeTo(
      [
        { u: 0, p: 0 },
        { u: 1, p: 0.9 },
      ],
      0.95,
      200,
    ),
    null,
  );
  assert.equal(
    timeTo(
      [
        { u: 0, p: 1 },
        { u: 1, p: 1 },
      ],
      0.95,
      200,
    ),
    200,
    'already there at a flat stretch',
  );
});

test('transition: duration, time to 95%, curve and nearest named easing of each animation', () => {
  const palette = {
    fade: [0, 0, 0.2, 1] as [number, number, number, number],
    slide: [0.32, 0.72, 0, 1] as [number, number, number, number],
  };
  const fade = transition(synth, { region: [0, 100, 640, 80], palette });
  assert.equal(fade?.startMs, 600);
  assert.equal(fade?.durationMs, 200);
  assert.equal(fade?.nearest[0].name, 'fade');
  assert.equal(fade?.dropped, 0);
  assert.ok((fade?.to95Ms ?? 0) < 200);
  const slide = transition(synth, { region: [0, 200, 640, 60], mode: 'x', palette });
  assert.equal(slide?.nearest[0].name, 'slide');
  assert.equal(slide?.dropped, 2);
  assert.equal(slide?.overshoot, 0);
  assert.equal(transition(synth, { region: [0, 100, 640, 80], after: 5000 }), null);
  // a box that blinks on and off: the first run comes back to where it started, so the next one is measured
  const blink = drawVideo(40, 40, 1, 40, (t, fill) => {
    if (t > 0.1 && t < 0.15) fill(0, 0, 40, 40, 200);
    if (t > 0.4) fill(0, 0, 40, 20, 200);
  });
  const r = transition(blink, { region: [0, 0, 40, 40], mergeMs: 50 });
  assert.equal(r?.startMs, 400);
  assert.equal(transition(blink, { region: [0, 0, 40, 40], mergeMs: 50, mode: 'x' }), null, 'nothing shifted in any run');
});
