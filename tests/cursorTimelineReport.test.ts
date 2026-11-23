// scripts/cursor-timeline-report.mjs: the spring model, its fit, the per-click measurements and the table, on a synthetic run of the shipped plan.
import { test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { planApproach } from '../shared/cursorApproach.mjs';
import { fitSpring, formatReport, main, measureClick, seesCursor, springProgress } from '../scripts/cursor-timeline-report.mjs';

const target = { x: 200, y: 150 };
const bounds = { x: 0, y: 0, width: 400, height: 300 };

/** The plan played at 1 ms steps, shown at t = 1000, hidden at its end. */
function played(plan: ReturnType<typeof planApproach>, shown = 1000) {
  const samples: any[] = [];
  for (let ms = 0; ms <= plan.totalMs + 30; ms++) {
    const s = plan.samples.reduce((a, b) => (Math.abs(b.t - ms) < Math.abs(a.t - ms) ? b : a));
    const gone = ms >= plan.pressAtMs + plan.hideAfterClickMs;
    samples.push({
      t: shown + ms,
      vis: !gone,
      page: gone ? 'hidden' : 'cursor',
      x: s.x,
      y: s.y,
      cur: gone ? 0 : 1,
      arrow: ms < plan.pressAtMs ? 1 : 0,
      disc: ms < plan.pressAtMs ? 0 : 1,
    });
  }
  return samples;
}

test('the spring is at rest at 0 and near 1 later, for every damping', () => {
  for (const z of [0.7, 1, 1.3]) {
    assert.equal(springProgress(0, 0.25, z), 0);
    assert.equal(springProgress(-5, 0.25, z), 0);
    assert.ok(springProgress(1500, 0.25, z) > 0.999);
  }
});

test('the shipped plan fits back to its response and critical damping', () => {
  const plan = planApproach({ from: { x: 60, y: 150 }, to: target, bounds });
  const samples = played(plan);
  const clickAt = 1000 + plan.pressAtMs;
  const m: any = measureClick({ samples, target, prev: { x: 60, y: 150 }, approachAt: 990, clickAt, until: clickAt + 400, shownAt: 1000 });
  assert.equal(m.seen, true);
  assert.ok(Math.abs(m.startPt - plan.distance) < 1);
  assert.ok(m.startOnLinePt < 0.5);
  assert.ok(m.straightness < 0.5);
  assert.ok(Math.abs(m.response - 0.25) <= 0.02, `response ${m.response}`);
  assert.ok(Math.abs(m.damping - 1) <= 0.1, `damping ${m.damping}`);
  assert.ok(m.hoverMs > 20);
  assert.ok(Math.abs(m.visibleBeforeClickMs - plan.pressAtMs) < 1);
  assert.ok(m.goneAfterClickMs <= 8);
  assert.match(formatReport([{ name: 'plan', m }]), /Sky \(observed\)/);
  // the overlay window's own hide time wins over the sampler's first no-cursor sample (the sampler stops with a hidden window, so that sample can come much later)
  const hidden: any = measureClick({
    samples,
    target,
    prev: { x: 60, y: 150 },
    approachAt: 990,
    clickAt,
    until: clickAt + 400,
    shownAt: 1000,
    hiddenAt: clickAt + 3,
  });
  assert.equal(hidden.goneAfterClickMs, 3);
  const unknown: any = measureClick({
    samples,
    target,
    prev: { x: 60, y: 150 },
    approachAt: 990,
    clickAt: null,
    until: clickAt + 400,
    shownAt: 1000,
    hiddenAt: clickAt + 3,
  });
  assert.equal(unknown.goneAfterClickMs, null, 'no click, no gone-after-click');
});

test('a cursor that never showed, no click, and a jump are reported', () => {
  assert.deepEqual(measureClick({ samples: [], target, prev: null, approachAt: 0, clickAt: null, until: 100 }), {
    seen: false,
    clickSent: false,
  });
  const jump = played(planApproach({ from: null, to: target, bounds, reducedMotion: true }));
  const m: any = measureClick({ samples: jump, target, prev: null, approachAt: 0, clickAt: null, until: 5000 });
  assert.equal(m.startPt, 0);
  assert.equal(m.goneAfterClickMs, null);
  assert.equal(m.visibleBeforeClickMs, null);
  assert.match(
    formatReport([
      { name: 'never', m: { seen: false } as any },
      { name: 'jump', m },
    ]),
    /cursor never seen/,
  );
  assert.equal(fitSpring([]).rms, Infinity);
  assert.equal(seesCursor({ vis: true, page: 'blank', cur: 1, arrow: 1, disc: 0 }), false);
});

test('the page animation clock gives the lag, the click against arrival and the exit', () => {
  const plan = planApproach({ from: { x: 60, y: 150 }, to: target, bounds });
  const lag = 250;
  const org = 500;
  const anims = [
    { n: 'glide', st: 1000 + lag - org, d: plan.durationMs },
    { n: 'life', st: 1000 + lag - org, d: plan.totalMs },
  ];
  const samples = played(plan).map((s) => ({ ...s, org, anims }));
  const clickAt = 1000 + plan.pressAtMs;
  const m: any = measureClick({ samples, target, prev: null, approachAt: 990, clickAt, until: clickAt + 400, shownAt: 1000 });
  assert.equal(m.animLagMs, lag);
  assert.ok(Math.abs(m.clickAfterArrivalMs - (plan.pressAtMs - lag - plan.durationMs)) < 1e-6);
  assert.ok(Math.abs(m.exitAfterClickMs - (lag + plan.hideAfterClickMs)) < 1e-6);
  assert.match(formatReport([{ name: 'late', m }]), /late/);
});

/** A run straight from `from` to the target, one sample per ms, with `n` ms of travel. */
function line(from: { x: number; y: number }, n: number, t0 = 0) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const k = i / n;
    return {
      t: t0 + i,
      vis: true,
      page: 'cursor',
      x: from.x + (target.x - from.x) * k,
      y: from.y + (target.y - from.y) * k,
      cur: 1,
      arrow: 1,
      disc: 0,
    };
  });
}

test('long runs are thinned for the fit, and a fixed damping or too few points are handled', () => {
  const m: any = measureClick({ samples: line({ x: 0, y: 150 }, 300), target, prev: null, approachAt: 0, clickAt: null, until: 400 });
  assert.ok(Number.isFinite(m.response));
  const pts = Array.from({ length: 30 }, (_, i) => ({ t: i * 10, p: springProgress(i * 10, 0.25, 1) }));
  const fixed = fitSpring(pts, { fixedDamping: 1 });
  assert.equal(fixed.damping, 1);
  assert.ok(Math.abs(fixed.response - 0.25) <= 0.01);
  assert.equal(fitSpring(pts.slice(0, 2)).rms, Infinity);
  const under = fitSpring(pts.map((p) => ({ ...p, p: springProgress(p.t, 0.25, 0.7) })));
  assert.ok(under.rms < 0.05);
  assert.ok(Number.isFinite(springProgress(100, 0.25, 0.7)) && Number.isFinite(springProgress(100, 0.25, 1.4)));
});

test('a cursor that never arrives, a click before the first sample and a start on the target', () => {
  const far = line({ x: 0, y: 150 }, 10).map((s) => ({ ...s, x: 0, y: 0 }));
  const never: any = measureClick({ samples: far, target, prev: { x: 0, y: 0 }, approachAt: 0, clickAt: 50, until: 100 });
  assert.equal(never.travelMs, null);
  assert.equal(never.hoverMs, null);
  const early: any = measureClick({ samples: far, target, prev: null, approachAt: 0, clickAt: -5, until: 100 });
  assert.equal(early.straightness, null);
  assert.equal(early.samples, 0);
  const onTarget = line(target, 3).map((s) => ({ ...s, x: target.x, y: target.y }));
  const same: any = measureClick({ samples: onTarget, target, prev: target, approachAt: 0, clickAt: 2, until: 100 });
  assert.equal(same.startPt, 0);
  assert.equal(same.straightness, 0);
  assert.equal(same.startOnLinePt, null);
  assert.equal(same.hoverMs, 2);
  assert.equal(same.goneAfterClickMs, null);
  assert.equal(same.response, NaN);
});

test('animation clocks without a glide or without a life', () => {
  const base = line({ x: 0, y: 150 }, 30);
  const noGlide = base.map((s) => ({ ...s, org: 10, anims: [{ n: 'life', st: 5, d: 100 }] }));
  const a: any = measureClick({ samples: noGlide, target, prev: null, approachAt: 0, clickAt: 20, until: 100, shownAt: 0 });
  assert.equal(a.clickAfterArrivalMs, 5);
  assert.equal(a.exitAfterClickMs, 95);
  const noLife = base.map((s) => ({ ...s, org: 10, anims: [{ n: 'glide', st: 5, d: 100 }] }));
  const b: any = measureClick({ samples: noLife, target, prev: null, approachAt: 0, clickAt: 20, until: 100, shownAt: 0 });
  assert.equal(b.animLagMs, null);
  assert.equal(b.exitAfterClickMs, null);
  const unstarted = base.map((s) => ({ ...s, org: 10, anims: [{ n: 'life', st: null, d: 100 }] }));
  const c: any = measureClick({ samples: unstarted, target, prev: null, approachAt: 0, clickAt: null, until: 100 });
  assert.equal(c.animLagMs, null);
  assert.equal(c.clickAfterArrivalMs, null);
});

test('the CLI prints the table, tolerates a trace without rows and explains its usage', () => {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const io = (trace: unknown) => ({
    readFile: (f: string) => (f === 't.json' ? JSON.stringify(trace) : ''),
    log: (s: string) => out.push(s),
    error: (s: string) => err.push(s),
    exit: (c: number) => {
      codes.push(c);
    },
  });
  main(['node', 'x'], io({}) as any);
  assert.deepEqual(codes, [2]);
  assert.match(err[0], /usage/);
  assert.equal(out.length, 0);
  main(['node', 'x', 't.json'], io({ rows: [{ name: 'r', m: { seen: false } }] }) as any);
  assert.match(out[0], /cursor never seen/);
  main(['node', 'x', 't.json'], io({}) as any);
  assert.match(out[1], /Sky \(observed\)/);
});

test('the CLI reads the real file by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-report-'));
  const file = path.join(dir, 'trace.json');
  fs.writeFileSync(file, JSON.stringify({ rows: [] }));
  const log = mock.method(console, 'log', () => {});
  try {
    main(['node', 'x', file]);
    assert.match(String(log.mock.calls[0].arguments[0]), /Sky \(observed\)/);
  } finally {
    log.mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI entry runs main on the process arguments', async () => {
  const error = mock.method(console, 'error', () => {});
  const exit = mock.method(process, 'exit', () => undefined as never);
  const argv = process.argv;
  try {
    process.argv = ['node', 'x'];
    await import('../scripts/cursor-timeline-report-cli.mjs');
    assert.deepEqual(exit.mock.calls[0].arguments, [2]);
    assert.match(String(error.mock.calls[0].arguments[0]), /usage/);
  } finally {
    process.argv = argv;
    error.mock.restore();
    exit.mock.restore();
  }
});
