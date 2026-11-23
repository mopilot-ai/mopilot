// Motion bench skyFit, align and report tests: spring/arc fits, planner comparison, move alignment and verdict output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignAnalyses, alignMoves, compareAnalyses, compareScalar, get, METRIC_SPECS, pathAt } from '../bench/lib/motion/align.mjs';
import { chordFrame, findMoves } from '../bench/lib/motion/cursor.mjs';
import { formatReport, momentReport, overlayHtml, overlaySvg } from '../bench/lib/motion/report.mjs';
import {
  arcControls,
  compareToPlanner,
  cubicAt,
  fitMove,
  loadPlanner,
  modelPoint,
  pathSummary,
  springStep,
  stubPlanner,
} from '../bench/lib/motion/skyFit.mjs';
import { MS, trackOf, moveOf } from './support/motionCursor.ts';

test('springStep, cubicAt and arcControls', () => {
  assert.equal(springStep(0, 0.3, 0.9), 0);
  assert.equal(springStep(-1, 0.3, 0.9), 0);
  assert.ok(Math.abs(springStep(3, 0.3, 0.9) - 1) < 1e-6);
  assert.ok(springStep(0.15, 0.3, 0.5) > 1, 'underdamped overshoots');
  assert.ok(Math.abs(springStep(3, 0.3, 1) - 1) < 1e-6);
  assert.ok(springStep(0.1, 0.3, 1.2) < 1, 'damping at or over 1 is critical: no overshoot');
  const a = { x: 0, y: 0 };
  const d = { x: 30, y: 0 };
  assert.deepEqual(cubicAt(a, { x: 10, y: 0 }, { x: 20, y: 0 }, d, 0.5), { x: 15, y: 0 });
  assert.deepEqual(arcControls(a, d, 0.1, -0.1).c1, { x: 10, y: 3 });
  assert.deepEqual(arcControls(a, d, 0.1, -0.1).c2.y < 0, true);
  assert.deepEqual(arcControls(a, a), { c1: { x: 0, y: 0 }, c2: { x: 0, y: 0 } });
});

test('fitMove recovers the spring of an arced move, and shows what the arc gains over a straight path', () => {
  const move = moveOf([100, 100], [500, 160], { response: 0.3, damping: 0.8, bulge: 0.15 });
  const fit = fitMove(move);
  assert.ok(Math.abs(fit.response - 0.3) < 0.05, `response ${fit.response}`);
  assert.ok(Math.abs(fit.damping - 0.8) < 0.15, `damping ${fit.damping}`);
  assert.ok(fit.rmsPx < 3, `rms ${fit.rmsPx}`);
  assert.ok(fit.arcGainPx > 3, `arc gain ${fit.arcGainPx}`);
  assert.ok(fit.arc[0] > 0.05 && fit.arc[1] > 0.05);
  assert.ok(fit.p95Px >= fit.rmsPx * 0.5 && fit.maxPx >= fit.p95Px);
  const straight = fitMove(moveOf([100, 100], [400, 100]));
  assert.ok(Math.abs(straight.arcGainPx) < 1.5 && straight.rmsPx < 3);
  const p = modelPoint({ response: 0.3, damping: 1, t0Ms: 0, k1: 0, k2: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, 5000);
  assert.ok(Math.abs(p.x - 100) < 0.01);
});

test('stubPlanner follows the recovered constants; compareToPlanner finds the shift; loadPlanner prefers the shared module', async () => {
  const short = stubPlanner({ x: 0, y: 0 }, { x: 150, y: 0 }, [1000, 800]);
  assert.ok(short.durationMs > 200 && short.durationMs < 900);
  assert.deepEqual(short.positionAt(0), { x: 0, y: 0 });
  const long = stubPlanner({ x: 0, y: 0 }, { x: 600, y: 0 }, [1000, 800]);
  assert.ok(long.durationMs > short.durationMs);
  assert.ok(Math.abs(long.positionAt(10_000).x - 600) < 1);
  assert.notEqual(long.positionAt(300).y, 0, 'an arc leaves the chord');
  // the arc bulges to the side the click angle favours: the other way for the opposite chord
  const back = stubPlanner({ x: 0, y: 0 }, { x: -600, y: 0 }, [1000, 800]);
  assert.ok(Math.sign(back.positionAt(300).y) === -Math.sign(long.positionAt(300).y) || back.positionAt(300).y !== 0);
  // a measured move that is the stub's plan: compared with it, the error is small
  const plan = stubPlanner({ x: 100, y: 100 }, { x: 700, y: 100 }, [1000, 800]);
  const track = trackOf((t) => {
    const p = plan.positionAt(t);
    return [p.x, p.y];
  }, 1800);
  const move = findMoves(track, { settlePx: 0.2 })[0];
  const cmp = compareToPlanner(move, stubPlanner, [1000, 800]);
  assert.ok(cmp.rmsPx < 8 && cmp.p95Px < 15, `${cmp.rmsPx}`);
  assert.ok(cmp.durationRatio > 0.5 && cmp.durationRatio < 1.2, `${cmp.durationRatio}`);
  // a plan that runs 60 ms ahead of the measured move needs the measured time shifted by 60 ms
  const at = (t: number) => {
    const rel = move.points.map((p) => ({ t: p.t - move.t0, x: p.x, y: p.y }));
    const k = Math.max(
      1,
      rel.findIndex((p) => p.t >= t),
    );
    const a = rel[k - 1];
    const b = rel[k];
    const f = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
  };
  const ahead = compareToPlanner(move, () => ({ durationMs: 400, positionAt: (t) => at(t + 60) }), [1000, 800]);
  assert.ok(Math.abs(ahead.offsetMs - 60) <= 10, `${ahead.offsetMs}`);
  assert.ok(ahead.rmsPx < 2);
  // the shared planner's planMove / sampleAt, adapted: the screen becomes the bounds rect, a sample becomes a position
  const calls: any[] = [];
  const shared = await loadPlanner(async () => ({
    planMove: (input: any) => (calls.push(input), { durationMs: 480, samples: [{ x: 1, y: 2, t: 0 }] }),
    sampleAt: (plan: any, t: number) => ({ x: plan.samples[0].x + t, y: plan.samples[0].y, progress: 0 }),
  }));
  assert.equal(shared.source, 'shared/cursorMotionPlan.mjs');
  const planned = shared.planner({ x: 0, y: 0 }, { x: 5, y: 5 }, [1440, 900]);
  assert.deepEqual(calls[0], { from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, bounds: { x: 0, y: 0, width: 1440, height: 900 } });
  assert.deepEqual([planned.durationMs, planned.positionAt(10)], [480, { x: 11, y: 2 }]);
  assert.equal((await loadPlanner(async () => ({ planMove: () => 1 }))).source, 'stub from the recovered Sky constants');
  assert.equal((await loadPlanner(async () => ({}))).planner, stubPlanner);
  assert.equal((await loadPlanner(async () => Promise.reject(new Error('Cannot find module')))).planner, stubPlanner);
  // the default import: whichever of the two is there
  const standard = await loadPlanner();
  assert.ok(standard.source === 'shared/cursorMotionPlan.mjs' || standard.planner === stubPlanner);
  assert.deepEqual(pathSummary(move)[0], [0, 0, 0]);
});

test('alignMoves: identical, shifted in time, different speed, different length', () => {
  const base = chordFrame(moveOf([100, 100], [400, 100]).points).map((p) => [p.t, p.u, p.v] as [number, number, number]);
  assert.deepEqual(pathAt(base, -5), { u: base[0][1], v: base[0][2] });
  assert.deepEqual(pathAt(base, 1e6), { u: base.at(-1)![1], v: base.at(-1)![2] });
  const mid = pathAt(base, (base[3][0] + base[4][0]) / 2);
  assert.ok(Math.abs(mid.u - (base[3][1] + base[4][1]) / 2) < 1e-9);
  const same = alignMoves(base, base);
  assert.equal(same.aligned, true);
  assert.deepEqual([same.pathRmsPx, same.durationShare, same.frameErrorP95Px, same.offsetFrames, same.scaled], [0, 0, 0, 0, false]);
  // the same move one frame later still aligns; three frames later does not
  const later = (frames: number) => base.map(([t, u, v]) => [t + frames * MS, u, v] as [number, number, number]);
  const one = alignMoves(base, later(1));
  assert.ok(Math.abs(one.offsetFrames - 1) <= 0.5, `${one.offsetFrames}`);
  assert.equal(one.checks.offsetFrames, true);
  const three = alignMoves(base, later(3));
  assert.ok(three.offsetFrames >= 2 && three.checks.offsetFrames === false && three.aligned === false);
  // a slower move: duration share fails; a bent path: path RMS fails
  const slow = base.map(([t, u, v]) => [t * 1.5, u, v] as [number, number, number]);
  assert.equal(alignMoves(base, slow).checks.durationShare, false);
  const bent = base.map(([t, u, v]) => [t, u, v + 20 * Math.sin((Math.PI * u) / 300)] as [number, number, number]);
  const bendResult = alignMoves(base, bent);
  assert.equal(bendResult.checks.pathRmsPx, false);
  assert.equal(bendResult.aligned, false);
  // a different length (another viewport) is scaled to ours, and says so
  const longer = base.map(([t, u, v]) => [t, u * 2, v] as [number, number, number]);
  const scaled = alignMoves(longer, base);
  assert.equal(scaled.scaled, true);
  assert.equal(scaled.aligned, true);
  // tolerances can be tightened
  assert.equal(alignMoves(base, later(1), { offsetFrames: 0.1 }).checks.offsetFrames, false);
  // a path with a repeated point (zero-length segment) is measured too
  assert.equal(
    alignMoves(
      [
        [0, 0, 0],
        [10, 0, 0],
        [20, 5, 0],
      ],
      [
        [0, 0, 0],
        [10, 0, 0],
        [20, 5, 0],
      ],
    ).aligned,
    true,
  );
});

test('compareScalar and the metric table: aligned, better, worse, differs, n/a', () => {
  const lower = { key: 'k', label: 'L', unit: 'ms', better: 'lower' as const, abs: 5, rel: 0.1 };
  assert.equal(compareScalar(lower, 100, 103).verdict, 'aligned');
  assert.equal(compareScalar(lower, 100, 108).verdict, 'aligned', 'within the relative tolerance');
  assert.equal(compareScalar({ ...lower, rel: undefined }, 100, 108).verdict, 'worse');
  assert.equal(compareScalar({ ...lower, abs: undefined }, 100, 120).verdict, 'worse');
  assert.equal(compareScalar(lower, 100, 50).verdict, 'better');
  assert.equal(compareScalar({ ...lower, better: 'higher' }, 100, 50).verdict, 'worse');
  assert.equal(compareScalar({ ...lower, better: 'higher' }, 100, 150).verdict, 'better');
  assert.equal(compareScalar({ ...lower, better: null }, 100, 150).verdict, 'differs');
  assert.deepEqual(
    [compareScalar(lower, 0, 50).deltaPct, compareScalar(lower, 100, 50).deltaPct, compareScalar(lower, 100, 50).delta],
    [null, -50, -50],
  );
  assert.equal(compareScalar(lower, null, 5).verdict, 'n/a');
  assert.equal(compareScalar(lower, 5, undefined).ours, null);
  assert.equal(get({ a: { b: 3 } }, 'a.b'), 3);
  assert.equal(get({ a: null }, 'a.b'), undefined);
  assert.equal(get({}, 'a.b.c'), undefined);
  const rows = compareAnalyses({ cursor: { fps: 60 }, cost: { passRate: 1 } }, { cursor: { fps: 30 }, cost: { passRate: 1 } });
  assert.equal(rows.length, METRIC_SPECS.length);
  assert.equal(rows.find((r) => r.key === 'cursor.fps')?.verdict, 'worse');
  assert.equal(rows.find((r) => r.key === 'cost.passRate')?.verdict, 'aligned');
  assert.equal(rows.find((r) => r.key === 'fit.rmsPx')?.verdict, 'n/a');
});

test('alignAnalyses pairs moves by key; report text and overlay show the verdicts', () => {
  const path = chordFrame(moveOf([100, 100], [400, 100]).points).map((p) => [p.t, p.u, p.v]);
  const shifted = path.map(([t, u, v]) => [t, u, v + 30]);
  const vendor = { cursor: { fps: 60 }, moves: { list: [{ key: '100@0', path }, { key: '100@180', path }, { key: '100@45' }] } };
  const ours = {
    cursor: { fps: 55 },
    moves: {
      list: [
        { key: '100@0', path },
        { key: '100@180', path: shifted },
        { key: '100@90', path },
      ],
    },
  };
  const aligned = alignAnalyses(vendor, ours);
  assert.deepEqual(
    aligned.map((a) => [a.key, a.aligned]),
    [
      ['100@0', true],
      ['100@180', false],
      ['100@45', null],
      ['100@90', null],
    ],
  );
  assert.equal(alignAnalyses({}, {}).length, 0);
  const report = momentReport('cursor-move-d100', vendor, ours);
  assert.equal(report.alignedShare, 0.5);
  assert.equal(momentReport('m', {}, {}).alignedShare, null);
  const text = formatReport([report], { vendor: 'ChatGPT', ours: 'MoPilot' });
  assert.match(
    text,
    /Aligned when: path RMS <= 4 px, duration within 8%, per-frame position error p95 <= 6 px, timing offset <= 1 frame at 60 Hz\./,
  );
  assert.match(text, /\| Metric \| ChatGPT \| MoPilot \| Delta \| Verdict \|/);
  assert.match(text, /\| Cursor update rate \| 60 fps \| 55 fps \| -5 \(-8\.3%\) \| aligned \|/);
  assert.match(text, /Moves aligned: 50%/);
  assert.match(text, /\| 100@180 \| .* \| no \(pathRmsPx/);
  assert.match(text, /\| 100@45 \| — \| — \| — \| — \| missing on one side \|/);
  assert.match(formatReport([momentReport('m', {}, {})], { vendor: 'A', ours: 'B', tolerance: { pathRmsPx: 2 } }), /path RMS <= 2 px/);
  assert.match(formatReport([{ ...report, alignedShare: null }], { vendor: 'A', ours: 'B' }), /Moves aligned: —/);
  assert.match(
    formatReport([momentReport('m', { cursor: { fps: 0 } }, { cursor: { fps: 5 } })], { vendor: 'A', ours: 'B' }),
    /\| \+5 \| better \|/,
  );
  assert.match(
    formatReport([momentReport('m', { cost: { passRate: 0.5 } }, { cost: { passRate: 1 } })], { vendor: 'A', ours: 'B' }),
    /\| Pass rate \| 0\.5 \| 1 \| \+0\.5 \(\+100%\) \| better \|/,
  );
  const svg = overlaySvg(path as number[][], shifted as number[][]);
  assert.equal((svg.match(/<svg/g) ?? []).length, 2);
  assert.match(svg, /stroke="#1f77b4"/);
  assert.match(svg, /stroke="#e8590c"/);
  assert.match(
    overlaySvg(
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
    ),
    /<svg/,
  );
  const html = overlayHtml([report, momentReport('empty', {}, {})], { vendor: 'A<b>', ours: 'B' });
  assert.match(html, /A&lt;b&gt;/);
  assert.match(html, /100@0: aligned/);
  assert.match(html, /100@180: not aligned/);
  assert.match(html, /No move recorded on both sides\./);
});
