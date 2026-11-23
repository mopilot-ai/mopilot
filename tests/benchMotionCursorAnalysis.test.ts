// Motion bench cursorBench tests: origin fit and cursor, click, typing, scroll and calibration analysis on fixture runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCursor } from '../bench/lib/motion/cursor.mjs';
import {
  analyzeCalibration,
  analyzeClicks,
  analyzeCursor,
  dotDiscs,
  fitOrigin,
  originFromEvents,
} from '../bench/lib/motion/cursorBench.mjs';
import { DOT_LUMA, REPEAT_COUNT, TYPE_TEXT } from '../bench/lib/motion/fixture.mjs';
import { stubPlanner } from '../bench/lib/motion/skyFit.mjs';
import { calibrationRun, cursorVideo, fixtureRun, ORIGIN, WALL0, trackOf } from './support/motionCursor.ts';

test('originFromEvents, fitOrigin and dotDiscs', () => {
  assert.equal(originFromEvents([{ type: 'click', t: 0, trusted: false, sx: 5, cx: 1 }], 2), null);
  assert.equal(
    originFromEvents([{ type: 'click', t: 0, trusted: true, sx: 10, cx: 10, sy: 5, cy: 5 }], 2),
    null,
    'a page that reports no screen offset',
  );
  assert.deepEqual(
    originFromEvents(
      [
        { type: 'click', t: 0, trusted: true, sx: 110, cx: 10, sy: 70, cy: 20 },
        { type: 'click', t: 1, trusted: true, sx: 210, cx: 110, sy: 70, cy: 20 },
        { type: 'ready', t: 2 },
      ],
      2,
    ),
    { x: 200, y: 100 },
  );
  const track = trackOf((t) => [150, 90], 500);
  assert.deepEqual(
    fitOrigin(
      track,
      [
        { t: 200, cx: 50, cy: 20 },
        { t: 300, cx: 50, cy: 20 },
        { t: 9999, cx: 0, cy: 0 },
      ],
      1,
    ),
    { x: 100, y: 70 },
  );
  assert.equal(fitOrigin(track, [{ t: 9999, cx: 0, cy: 0 }], 1), null);
  assert.equal(fitOrigin([], [], 1), null);
  const discs = dotDiscs(
    [
      { type: 'show', t: 1000, x: 10, y: 20 },
      { type: 'show', t: 2000, x: 30, y: 40 },
      { type: 'done', t: 3000 },
    ],
    (w) => w - 1000,
    { x: 100, y: 50 },
    2,
  );
  assert.deepEqual(discs[0], { t0: -80, t1: 1080, x: 120, y: 90, r: 34, luma: DOT_LUMA, tol: 14 });
  assert.equal(discs[1].t1, 3000);
  assert.deepEqual(
    dotDiscs([], (w) => w, { x: 0, y: 0 }, 1),
    [],
  );
});

test('analyzeCursor on a fixture run: matched moves, paths, fit, latencies and click feedback', () => {
  const { video, events, plan } = fixtureRun();
  const planner = { planner: stubPlanner, source: 'stub' };
  const results = [
    { kind: 'deadAir', region: 'screen', longestMs: 1500, gaps: [{ from: 1, to: 2, ms: 1500 }] },
    { kind: 'cadence', region: 'thumb', updates: 4, medianMs: 200, perSecond: 5 },
    { kind: 'dropped', error: 'x' },
  ];
  const a = analyzeCursor({ video, events, toVideo: (w) => w - WALL0, pxPerPoint: 1, marks: { send: 200 }, planner, results });
  assert.equal(a.origin?.from, 'events');
  assert.deepEqual([a.origin?.x, a.origin?.y], [ORIGIN.x, ORIGIN.y]);
  assert.equal(a.moves.expected, 8);
  assert.equal(a.moves.matched, 8, JSON.stringify(a.moves.list.map((m: any) => [m.key, m.matched])));
  for (const m of a.moves.list as any[]) {
    assert.ok(m.durationMs > 150 && m.durationMs < 1100, `${m.key} ${m.durationMs}`);
    assert.ok(m.landingPx < 4, `${m.key} landing ${m.landingPx}`);
    assert.ok(m.thinkMs > 380 && m.thinkMs < 480, `${m.key} think ${m.thinkMs}`);
    assert.ok(m.dwellMs > 0, `${m.key} dwell`);
    assert.ok(Math.abs(m.fit.response - 0.25) < 0.08, `${m.key} response ${m.fit.response}`);
    assert.equal(m.path[0][0], 0);
  }
  assert.ok(a.latency.firstActionMs! > 600 && a.latency.firstActionMs! < 900, `${a.latency.firstActionMs}`);
  assert.ok(a.clicks!.hits === plan.points.length && a.clicks!.misses === 0);
  assert.ok(a.latency.cycleMs! > 1300 && a.latency.cycleMs! < 1340, `${a.latency.cycleMs}`);
  assert.ok(a.latency.feedbackMs! > 0 && a.latency.feedbackMs! < 80, `${a.latency.feedbackMs}`);
  assert.ok(a.latency.thinkMs! > 380 && a.latency.dwellMs! > 0);
  assert.ok(a.cursor.fps! > 25 && a.cursor.fps! < 35, `${a.cursor.fps}`);
  assert.ok(a.fit.rmsPx! < 3 && Math.abs(a.fit.response! - 0.25) < 0.08);
  assert.equal(a.fit.planner.source, 'stub');
  assert.ok(a.fit.planner.rmsPx! >= 0);
  assert.deepEqual(a.gaps, { longestMs: 1500, count: 1, list: [{ from: 1, to: 2, ms: 1500 }] });
  assert.deepEqual(a.overlay, { updates: 4, updatesPerSecond: 5, medianMs: 200 });
  assert.equal(a.typing, null);
  assert.equal(a.idle, null);
  assert.deepEqual(a.notes, []);
  assert.equal(a.track.moves >= 8, true);
  assert.deepEqual(a.plan, { kind: 'move', skipped: [] });

  // no trusted click: the origin is fitted from where the cursor was at each click
  const fitted = analyzeCursor({
    video,
    events: events.map((e: any) => (e.type === 'click' ? { ...e, trusted: false } : e)),
    toVideo: (w) => w - WALL0,
    pxPerPoint: 1,
    planner,
  });
  assert.equal(fitted.origin?.from, 'fit');
  assert.ok(Math.abs(fitted.origin!.x - ORIGIN.x) < 3 && Math.abs(fitted.origin!.y - ORIGIN.y) < 3);
  assert.equal(fitted.moves.matched, 8);
  assert.match(fitted.notes[0], /origin fitted/);
  assert.equal(fitted.gaps, null);
  assert.equal(fitted.overlay, null);

  // a given origin wins; a fit that finds no click leaves the origin unknown
  assert.equal(
    analyzeCursor({ video, events, toVideo: (w) => w - WALL0, pxPerPoint: 1, planner, origin: { x: 50, y: 30 } }).origin?.from,
    'given',
  );
  const nothing = analyzeCursor({
    video,
    events: events.filter((e: any) => e.type !== 'click' || !e.hit),
    toVideo: (w) => w - WALL0,
    pxPerPoint: 1,
    planner,
  });
  assert.equal(nothing.origin, null);
  assert.equal(nothing.moves.matched, 0);
  assert.equal(nothing.latency.firstActionMs !== undefined, true);

  // no clock sync: moves still found, nothing joined to the page's events
  const unsynced = analyzeCursor({ video, events, toVideo: null, pxPerPoint: 1, planner });
  assert.equal(unsynced.clicks, null);
  assert.equal(unsynced.latency.cycleMs, null);
  assert.ok(unsynced.notes.some((n: string) => /clock sync not seen/.test(n)));
  assert.equal(unsynced.moves.matched, 8);

  // no ready event: no plan, no ground truth
  const bare = analyzeCursor({ video, events: [], toVideo: (w) => w, pxPerPoint: 1, planner });
  assert.equal(bare.plan, null);
  assert.equal(bare.viewport, null);
  assert.equal(bare.moves.matched, 0);
  assert.ok(bare.track.moves >= 8);
  assert.equal(bare.latency.firstActionMs !== null, true);
  const empty = analyzeCursor({ video: { ...video, frames: [] }, events: [], toVideo: null, pxPerPoint: 1, planner });
  assert.equal(empty.latency.firstActionMs, null);
});

test('analyzeCursor on the other plans: repeat, type, scroll and idle', () => {
  const { video, events } = fixtureRun();
  const planner = { planner: stubPlanner, source: 'stub' };
  const ready = (fixture: object) =>
    events.map((e: any) => (e.type === 'ready' ? { ...e, fixture } : e)).filter((e: any) => e.type === 'ready');
  const withClicks = (fixture: object) => [...ready(fixture), ...events.filter((e: any) => e.type === 'click')];
  const repeat = analyzeCursor({ video, events: withClicks({ plan: 'repeat' }), toVideo: (w) => w - WALL0, pxPerPoint: 1, planner });
  assert.equal(repeat.plan?.kind, 'repeat');
  assert.equal(repeat.moves.expected, REPEAT_COUNT - 1);
  assert.equal(repeat.moves.matched, 0);

  const keys = [0, 1, 2, 3, 4].map((i) => ({ type: 'key', t: WALL0 + 3000 + i * 120, value: 'motion'.slice(0, i + 1) }));
  const submit = { type: 'submit', t: WALL0 + 3800, value: TYPE_TEXT, ok: true };
  const typed = analyzeCursor({
    video,
    events: [...withClicks({ plan: 'type' }), ...keys, submit],
    toVideo: (w) => w - WALL0,
    pxPerPoint: 1,
    planner,
  });
  assert.equal(typed.typing?.keys, 5);
  assert.equal(typed.typing?.submitted, true);
  assert.equal(typed.typing?.intervalMs.p50, 120);
  assert.equal(typed.typing?.totalMs, 480);
  assert.equal(typed.typing?.enterAfterMs, 320);
  const quiet = analyzeCursor({ video, events: withClicks({ plan: 'type' }), toVideo: (w) => w - WALL0, pxPerPoint: 1, planner });
  assert.deepEqual(
    [quiet.typing?.keys, quiet.typing?.submitted, quiet.typing?.totalMs, quiet.typing?.echoMs, quiet.typing?.enterAfterMs],
    [0, null, null, null, null],
  );
  const unsubmitted = analyzeCursor({
    video,
    events: [...withClicks({ plan: 'type' }), keys[0], { type: 'submit', t: WALL0 + 4000, ok: false }],
    toVideo: (w) => w - WALL0,
    pxPerPoint: 1,
    planner,
  });
  assert.equal(unsubmitted.typing?.submitted, false);

  const scrolls = [0, 120, 240, 120, 0].map((y, i) => ({ type: 'scroll', t: WALL0 + 4000 + i * 100, y }));
  const scrolled = analyzeCursor({
    video,
    events: [...withClicks({ plan: 'scroll' }), ...scrolls],
    toVideo: (w) => w - WALL0,
    pxPerPoint: 1,
    planner,
  });
  assert.deepEqual(
    [scrolled.scroll?.events, scrolled.scroll?.maxY, scrolled.scroll?.totalMs, scrolled.scroll?.stepPx.p50],
    [5, 240, 400, 120],
  );
  assert.equal(scrolled.scroll?.intervalMs.p50, 100);
  const unscrolled = analyzeCursor({ video, events: withClicks({ plan: 'scroll' }), toVideo: (w) => w - WALL0, pxPerPoint: 1, planner });
  assert.deepEqual([unscrolled.scroll?.events, unscrolled.scroll?.maxY, unscrolled.scroll?.visibleMs], [0, null, null]);

  const idle = analyzeCursor({
    video,
    events: [...ready({ plan: 'idle' }), { type: 'done', t: WALL0 + 3000 }],
    toVideo: (w) => w - WALL0,
    pxPerPoint: 1,
    planner,
  });
  assert.equal(idle.idle?.fullMass !== undefined, true);
  const never = analyzeCursor({ video, events: ready({ plan: 'idle' }), toVideo: (w) => w - WALL0, pxPerPoint: 1, planner });
  assert.equal(never.idle, null);
});

test('analyzeClicks, analyzeTyping and analyzeScroll count what the page logged', () => {
  const video = cursorVideo(() => null, { count: 60, extra: (t, fill) => t > 500 && fill(10, 10, 60, 30, 0) });
  const clicks = analyzeClicks(
    [
      { t: 480, hit: true },
      { t: 1000, hit: false },
      { t: 1480, hit: true },
    ],
    video,
    [0, 0, 100, 60],
  );
  assert.deepEqual([clicks.count, clicks.hits, clicks.misses, clicks.cycleMs.p50], [3, 2, 1, 1000]);
  assert.ok(clicks.feedbackMs! > 0 && clicks.feedbackMs! < 60, `${clicks.feedbackMs}`);
  assert.equal(analyzeClicks([], video, [0, 0, 100, 60]).feedbackMs, null);
});

test('analyzeCalibration: speed, clock offset and recorder rate against the known target', () => {
  const { video, plan, t0 } = calibrationRun();
  const track = detectCursor(video, { rect: [0, 0, 200, 100] });
  const result = analyzeCalibration(track, plan, t0, { x: 0, y: 0 }, 1);
  assert.equal(result.recorder.fps, 30);
  assert.equal(result.recorder.droppedShare, 0);
  assert.equal(result.clockOffsetMs, 0);
  assert.ok(result.positionRmsPx! < 1.5, `${result.positionRmsPx}`);
  assert.ok(result.foundShare! > 0.8);
  assert.equal(result.phases.length, 3);
  // 240 px/s is 8 px a frame at 30 fps: tracked within a few percent; 1200 px/s is 40 px a frame: still tracked
  assert.ok(result.phases[0].errorShare! < 0.05, JSON.stringify(result.phases));
  assert.ok(result.phases[1].errorShare! < 0.1);
  assert.ok(result.phases[2].measuredSpeed! > 0);
  // the page's clock 40 ms ahead of the recording shows as that offset
  const late = analyzeCalibration(track, plan, t0 + 40, { x: 0, y: 0 }, 1);
  assert.ok(Math.abs(late.clockOffsetMs + 40) <= 4, `${late.clockOffsetMs}`);
  const nothing = analyzeCalibration([], plan, 0, { x: 0, y: 0 }, 1);
  assert.deepEqual(
    [nothing.recorder.fps, nothing.recorder.droppedShare, nothing.positionRmsPx, nothing.foundShare],
    [null, null, null, null],
  );
  assert.deepEqual(
    nothing.phases.map((p) => p.measuredSpeed),
    [null, null, null],
  );
  const dropped = analyzeCalibration(
    track.filter((f, i) => i % 7),
    plan,
    t0,
    { x: 0, y: 0 },
    1,
  );
  assert.ok(dropped.recorder.droppedShare! > 0);
  // through analyzeCursor: the calibration plan reads the calib event
  const run = analyzeCursor({
    video,
    events: [
      { type: 'ready', t: WALL0, fixture: { plan: 'calibration' }, viewport: [200, 100] },
      { type: 'calib', t: WALL0 + t0 },
      { type: 'click', t: WALL0 + 10, trusted: true, sx: 5, cx: 5, sy: 7, cy: 7, hit: false, i: 0 },
    ],
    toVideo: (w) => w - WALL0,
    pxPerPoint: 1,
    planner: { planner: stubPlanner, source: 'stub' },
    origin: { x: 0, y: 0 },
  });
  assert.equal(run.calibration?.recorder.fps, 30);
  const missing = analyzeCursor({
    video,
    events: [{ type: 'ready', t: 0, fixture: { plan: 'calibration' }, viewport: [200, 100] }],
    toVideo: (w) => w,
    pxPerPoint: 1,
    planner: { planner: stubPlanner, source: 'stub' },
    origin: { x: 0, y: 0 },
  });
  assert.equal(missing.calibration, null);
});
