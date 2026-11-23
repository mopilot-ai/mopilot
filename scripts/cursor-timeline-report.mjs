// Analyses a sampled CU cursor timeline (tests/e2e/cuj-cursor-motion-timeline.spec.ts): per click, how far back it started, how long it was visible before the input, its travel, a critically damped spring fit, its straightness and how fast it went after the click, against the observed Sky cursor.
//   node scripts/cursor-timeline-report-cli.mjs <trace.json>   (the spec's attached trace: {rows} or {actions, samples})
import fs from 'node:fs';

/** The observed Sky cursor (VM recordings, #3810): ranges of the single runs, pt and ms. */
export const SKY = Object.freeze({
  startPt: [132, 149],
  visibleBeforeClickMs: [344, 428],
  travelMs: [233, 317],
  response: [0.25, 0.27],
  damping: 1.0,
  goneMs: 16.7,
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** At most `n` of `list`, evenly spread (first and last kept). */
const thin = (list, n) =>
  list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);

/** Progress (0..1) of a spring `ms` after it was let go, for a SwiftUI-style `response` in s and a damping ratio (1: critically damped). */
export function springProgress(ms, response, damping) {
  if (ms <= 0) return 0;
  const w = (2 * Math.PI) / response;
  const t = ms / 1000;
  const z = damping;
  if (Math.abs(z - 1) < 1e-9) return 1 - (1 + w * t) * Math.exp(-w * t);
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  }
  const s = w * Math.sqrt(z * z - 1);
  return 1 - Math.exp(-z * w * t) * (Math.cosh(s * t) + ((z * w) / s) * Math.sinh(s * t));
}

/**
 * Fits progress samples [{t (ms), p}] with a spring by grid search over response, damping and a start offset (the sampler's clock is
 * not the animation's). Returns {response, damping, offsetMs, rms} where rms is in progress units.
 */
/** @param {{ t: number, p: number }[]} points @param {{ fixedDamping?: number | null }} [options] */
export function fitSpring(points, { fixedDamping = null } = {}) {
  let best = { response: NaN, damping: NaN, offsetMs: 0, rms: Infinity };
  if (points.length < 3) return best;
  const t0 = points[0].t;
  const dampings = fixedDamping == null ? Array.from({ length: 21 }, (_, i) => 0.6 + i * 0.04) : [fixedDamping];
  for (let response = 0.15; response <= 0.5001; response += 0.005) {
    for (const damping of dampings) {
      for (let offsetMs = -80; offsetMs <= 80; offsetMs += 2) {
        let sum = 0;
        for (const q of points) {
          const e = springProgress(q.t - t0 - offsetMs, response, damping) - q.p;
          sum += e * e;
        }
        const rms = Math.sqrt(sum / points.length);
        if (rms < best.rms) best = { response, damping, offsetMs, rms };
      }
    }
  }
  return best;
}

/** Whether a sample shows the cursor: the window is up, its page is the cursor's, and an arrow or a disc is opaque. */
export const seesCursor = (s) => s.vis && s.page === 'cursor' && s.cur > 0 && (s.arrow > 0 || s.disc > 0);

/**
 * One click's measurements. `samples` are the whole run's samples [{t, vis, page, x, y, cur, arrow, disc}] (global-independent: x/y are
 * the cursor tip in window points); `target` and `prev` are in window points (prev null: no previous point); `approachAt` is when main
 * started the approach, `clickAt` when the helper received the click (null: no click was sent), `until` bounds the action and `hiddenAt` is when the overlay window hid (null: unknown).
 */
/** @param {{ samples: any[], target: {x:number,y:number}, prev: {x:number,y:number}|null, approachAt: number, clickAt: number|null, until: number, shownAt?: number|null, hiddenAt?: number|null }} input */
export function measureClick({ samples, target, prev, approachAt, clickAt, until, shownAt = null, hiddenAt = null }) {
  const mine = samples.filter((s) => s.t >= approachAt && s.t <= until);
  const first = mine.find(seesCursor);
  if (!first) return { seen: false, clickSent: clickAt != null };
  const start = { x: first.x, y: first.y };
  const startPt = dist(start, target);
  const run = mine.filter((s) => seesCursor(s) && s.t >= first.t && (clickAt == null || s.t <= clickAt));
  const arrived = run.find((s) => dist(s, target) <= 4);
  const travelMs = arrived ? arrived.t - first.t : null;
  // straightness: the largest distance of a sample from the line start -> target
  const line = { x: target.x - start.x, y: target.y - start.y };
  const len = Math.hypot(line.x, line.y);
  const off = (s) => (len < 1e-6 ? 0 : Math.abs((s.x - start.x) * line.y - (s.y - start.y) * line.x) / len);
  const straightness = run.length ? Math.max(...run.map(off)) : null;
  // the start is on the line back to the previous point (or on it when closer)
  /** @type {number | null} */
  const toPrev = prev ? dist(prev, target) : null;
  /** @type {number | null} */
  let startOnLinePt = null;
  if (prev && toPrev != null && toPrev > 1e-6 && len > 1e-6) {
    const d = { x: prev.x - target.x, y: prev.y - target.y };
    startOnLinePt = Math.abs((start.x - target.x) * d.y - (start.y - target.y) * d.x) / toPrev;
  }
  const moving = run.filter((s) => s.t <= (arrived ? arrived.t : Infinity));
  const fit =
    startPt >= 20 && moving.length >= 5
      ? fitSpring(thin(moving, 100).map((s) => ({ t: s.t, p: 1 - dist(s, target) / startPt })))
      : { response: NaN, damping: NaN, offsetMs: 0, rms: NaN };
  // the page's own animation clock: when the glide and the exit really started, against the window showing and the click
  const timed = mine.find((s) => s.anims?.some((a) => a.st != null));
  const life = timed?.anims.find((a) => a.n === 'life');
  const glide = timed?.anims.find((a) => a.n === 'glide');
  const animStartAt = life ? timed.org + life.st : null;
  const arrivalAt = animStartAt == null ? null : glide ? timed.org + glide.st + glide.d : animStartAt;
  const exitAt = animStartAt == null || !life ? null : animStartAt + life.d;
  const gone = clickAt == null ? null : samples.find((s) => s.t >= clickAt && !s.frame && !seesCursor(s));
  return {
    seen: true,
    clickSent: clickAt != null,
    startPt,
    startOnLinePt,
    visibleBeforeClickMs: clickAt == null ? null : clickAt - (shownAt ?? first.t),
    firstSampleLagMs: shownAt == null ? null : first.t - shownAt,
    travelMs,
    hoverMs: arrived && clickAt != null ? clickAt - arrived.t : null,
    response: fit.response,
    damping: fit.damping,
    fitRmsPt: Number.isFinite(fit.rms) ? fit.rms * startPt : NaN,
    straightness,
    // the window's own hide time when known: the sampler stops with a hidden window, so its first no-cursor sample can come a whole approach later
    goneAfterClickMs: clickAt == null ? null : hiddenAt != null ? hiddenAt - clickAt : gone ? gone.t - clickAt : null,
    animLagMs: animStartAt != null && shownAt != null ? animStartAt - shownAt : null,
    clickAfterArrivalMs: arrivalAt != null && clickAt != null ? clickAt - arrivalAt : null,
    exitAfterClickMs: exitAt != null && clickAt != null ? exitAt - clickAt : null,
    samples: run.length,
  };
}

const f = (v, d = 1) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(d));
/** @param {readonly number[]} r */
const range = (r, d = 0) => `${f(r[0], d)}-${f(r[1], d)}`;

/** The table of rows [{name, m}] (m from measureClick) against Sky's numbers. */
export function formatReport(rows) {
  const head = [
    'click',
    'start pt',
    'visible before click ms',
    'travel ms',
    'response s',
    'damping',
    'fit rms pt',
    'straight pt',
    'gone after click ms (sampled)',
    'anim start after show ms',
    'click after arrival ms',
    'exit after click ms',
  ];
  const body = rows.map(({ name, m }) =>
    m.seen
      ? [
          name,
          f(m.startPt),
          f(m.visibleBeforeClickMs, 0),
          f(m.travelMs, 0),
          f(m.response, 3),
          f(m.damping, 2),
          f(m.fitRmsPt, 2),
          f(m.straightness, 2),
          f(m.goneAfterClickMs, 1),
          f(m.animLagMs, 0),
          f(m.clickAfterArrivalMs, 0),
          f(m.exitAfterClickMs, 0),
        ]
      : [name, 'cursor never seen', '', '', '', '', '', '', '', '', '', ''],
  );
  const sky = [
    'Sky (observed)',
    range(SKY.startPt),
    range(SKY.visibleBeforeClickMs),
    range(SKY.travelMs),
    range(SKY.response, 2),
    f(SKY.damping, 1),
    '-',
    '-',
    `<${f(SKY.goneMs, 1)}`,
    '-',
    '>=0',
    '<16.7',
  ];
  const all = [head, ...body, sky];
  const width = head.map((_, c) => Math.max(...all.map((r) => String(r[c]).length)));
  return all.map((r) => r.map((cell, c) => String(cell).padEnd(width[c])).join('  ')).join('\n');
}

/** The CLI: prints the table for the trace file in argv[2]; `io` is injectable for tests. */
export function main(
  argv,
  io = { readFile: (file) => fs.readFileSync(file, 'utf8'), log: console.log, error: console.error, exit: process.exit },
) {
  const file = argv[2];
  if (!file) {
    io.error('usage: node scripts/cursor-timeline-report-cli.mjs <trace.json>');
    io.exit(2);
    return;
  }
  const trace = JSON.parse(io.readFile(file));
  io.log(formatReport(trace.rows ?? []));
}
