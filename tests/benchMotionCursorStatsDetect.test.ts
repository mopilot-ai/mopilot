// Motion bench stats, fixture, moments and cursor detection/move-cutting tests (bench/lib/motion stats, fixture, moments, cursor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chordFrame,
  detectCursor,
  findMoves,
  idleFade,
  matchMoves,
  medianBackground,
  pathShape,
  updateRate,
} from '../bench/lib/motion/cursor.mjs';
import {
  BACKGROUND_LUMA,
  calibrationPosition,
  DOT_LUMA,
  expectedMoves,
  classicFixtureSource,
  fixtureHtml,
  lumaOf,
  planFor,
  planMoves,
  REPEAT_COUNT,
  TYPE_TEXT,
} from '../bench/lib/motion/fixture.mjs';
import { checkSpec } from '../bench/lib/motion/measure.mjs';
import {
  CURSOR_MOMENTS,
  cursorPrompt,
  fixtureQuery,
  momentById,
  recordingSpec,
  resolveRegions,
  resolveSteps,
  SURFACES,
} from '../bench/lib/motion/moments.mjs';
import { median, quantile, rms, round, spread } from '../bench/lib/motion/stats.mjs';
import { cursorVideo, springAt, MS, trackOf, moveOf } from './support/motionCursor.ts';

test('stats: quantile, median, round, rms and spread handle empty and odd/even lists', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.95), 4);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(round(null), null);
  assert.equal(round(1.2345, 2), 1.23);
  assert.equal(rms([]), null);
  assert.equal(rms([3, 4]), Math.sqrt(12.5));
  assert.deepEqual(spread([]), { count: 0, p50: null, p95: null, max: null, jitter: null });
  assert.deepEqual(spread([10, 12, 30]), { count: 3, p50: 12, p95: 30, max: 30, jitter: 18 });
});

test('fixture: dots at fixed distances and directions, skipped pairs, and every plan kind', () => {
  assert.equal(lumaOf('#000000'), 0);
  assert.equal(DOT_LUMA, lumaOf('#00a676'));
  assert.ok(BACKGROUND_LUMA > DOT_LUMA);
  const moves = planMoves(200, [1000, 700]);
  assert.deepEqual(moves.skipped, []);
  assert.equal(moves.points.length, 12);
  assert.deepEqual(
    moves.points.map((p) => p.role),
    ['approach', 'out', 'back', 'reposition', 'out', 'back', 'reposition', 'out', 'back', 'reposition', 'out', 'back'],
  );
  // all eight directions at the distance, in the order the page shows them
  assert.deepEqual(
    moves.points.flatMap((p) => (p.move ? [p.move.angle] : [])),
    [0, 180, 45, 225, 90, 270, 135, 315],
  );
  for (const e of expectedMoves(moves)) {
    assert.ok(Math.abs(Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) - 200) < 1, `${e.angle}`);
    assert.ok(e.to.x >= 40 && e.to.y >= 40 && e.to.x <= 960 && e.to.y <= 660, 'inside the margin');
  }
  // 800 px up and down does not fit a 700 px viewport: that pair is skipped with its reason
  const tall = planMoves(800, [1440, 700]);
  assert.deepEqual(
    tall.skipped.map((s) => s.angle),
    [90],
  );
  assert.match(tall.skipped[0].reason, /needs 80x880, the viewport is 1440x700/);
  assert.equal(tall.points.length, 9);
  assert.equal(planFor({ plan: 'move', distance: 30 }, [800, 600]).kind, 'move');
  const repeat = planFor({ plan: 'repeat' }, [800, 600]);
  assert.equal(repeat.points.length, REPEAT_COUNT);
  assert.deepEqual(
    [repeat.points[0].role, repeat.points[0].move, repeat.points[1].role, repeat.points[1].move],
    ['approach', null, 'repeat', { distance: 0, angle: null }],
  );
  const type = planFor({ plan: 'type' }, [800, 600]);
  assert.equal(type.kind === 'type' && type.text, TYPE_TEXT);
  assert.deepEqual(type.kind === 'type' && type.field, { x: 200, y: 280, w: 400, h: 40 });
  assert.deepEqual(planFor({ plan: 'scroll' }, [800, 600]), { kind: 'scroll', points: [], pageHeight: 2400 });
  assert.equal(planFor({ plan: 'idle' }, [800, 600]).points.length, 1);
  const calibration = planFor({ plan: 'calibration' }, [800, 600]);
  assert.equal(calibration.kind, 'calibration');
  assert.deepEqual(
    expectedMoves(repeat).map((e) => e.index),
    [1, 2, 3, 4, 5],
  );
});

test('calibrationPosition sweeps at the phase speed, back and forth, and ends', () => {
  const plan = planFor({ plan: 'calibration' }, [1040, 600]);
  assert.equal(plan.kind, 'calibration');
  if (plan.kind !== 'calibration') return;
  assert.deepEqual(calibrationPosition(plan, 0), { x: 40, y: 300, speed: 240, phase: 0 });
  assert.equal(calibrationPosition(plan, 1000)?.x, 280);
  // 1000 px long sweep at 240 px/s: past the end it comes back
  assert.equal(calibrationPosition(plan, 5000)?.x, 40 + 720);
  assert.deepEqual(calibrationPosition(plan, 6500), { x: 340, y: 300, speed: 600, phase: 1 });
  assert.equal(calibrationPosition(plan, -1), null);
  assert.equal(calibrationPosition(plan, 18_000), null);
});

test('fixtureHtml is a classic-script page that loads the plans and logs what it sees', () => {
  const html = fixtureHtml();
  assert.doesNotMatch(html, /type="module"|\bimport\b.*from|import\(/);
  assert.match(html, /<script src="\/fixture\.js"><\/script>/);
  assert.match(html, /const \{ planFor, calibrationPosition, TYPE_TEXT \} = window\.__fixture;/);
  assert.match(html, /sendBeacon\('\/event'/);
  assert.match(html, /background:#00a676/);
});

test('moments: the cursor catalog, prompts per surface, the fixture query and steps', () => {
  assert.deepEqual(
    CURSOR_MOMENTS.map((m) => m.id),
    [
      'cursor-move-d30',
      'cursor-move-d100',
      'cursor-move-d200',
      'cursor-move-d400',
      'cursor-move-d800',
      'cursor-repeat',
      'cursor-click-type',
      'cursor-scroll',
      'cursor-idle-fade',
      'cursor-calibration',
    ],
  );
  for (const m of CURSOR_MOMENTS) {
    // each spec is valid and measurable: its regions resolve and its metrics name regions it has
    const window: [number, number, number, number] = [0, 0, 1000, 800];
    checkSpec(recordingSpec(m, resolveRegions(m, 'mopilot', window), window, 2));
    assert.equal(momentById(m.id), m);
  }
  assert.throws(() => momentById('nope'), /unknown moment nope; known: turn-start.*cursor-calibration/);
  const move = momentById('cursor-move-d200');
  assert.equal(fixtureQuery(move), `?fixture=${encodeURIComponent('{"plan":"move","distance":200}')}`);
  assert.match(
    cursorPrompt(move, 'iab', 'http://127.0.0.1:1/?x')!,
    /^Open http:\/\/127\.0\.0\.1:1\/\?x in your built-in browser.*Click the center of the dot/,
  );
  assert.match(cursorPrompt(move, 'cu', 'u')!, /^Use computer use only/);
  assert.match(cursorPrompt(move, 'bu', 'u')!, /^Use the browser extension in Chrome only/);
  // a MoPilot arm is told to use its app-scoped tools on the CU surface only
  assert.match(cursorPrompt(move, 'cu', 'u', 'mopilot')!, /app-scoped computer tools .* on the app "Motion fixture"/);
  assert.doesNotMatch(cursorPrompt(move, 'cu', 'u', 'claude')!, /app-scoped/);
  assert.doesNotMatch(cursorPrompt(move, 'iab', 'u', 'mopilot')!, /app-scoped/);
  // MoPilot's extension cannot see the bench's pre-opened tab, so its prompt gives the address; a vendor's keeps the open tab (#4033)
  assert.match(
    cursorPrompt(move, 'bu', 'http://127.0.0.1:1/?x', 'mopilot')!,
    /^Use the browser extension in Chrome only: open http:\/\/127\.0\.0\.1:1\/\?x in a new tab/,
  );
  assert.match(cursorPrompt(move, 'bu', 'u', 'claude')!, /on the open tab titled 'Motion fixture'/);
  assert.equal(cursorPrompt(momentById('cursor-calibration'), 'cu', 'u'), null);
  assert.equal(cursorPrompt(momentById('turn-start'), 'cu', 'u'), null);
  assert.deepEqual(Object.keys(SURFACES), ['cu', 'iab', 'bu']);
  const steps = resolveSteps(move, { prompt: 'PROMPT {x} here', url: 'U' });
  assert.deepEqual(steps[2], { do: 'paste', text: 'PROMPT {x} here' });
  assert.deepEqual(
    resolveSteps(
      {
        ...move,
        steps: [
          { do: 'paste', text: '{url} {prompt} {other}' },
          { do: 'wait', ms: 1 },
        ],
      },
      { prompt: 'P', url: 'U' },
    ),
    [
      { do: 'paste', text: 'U P {other}' },
      { do: 'wait', ms: 1 },
    ],
  );
  assert.equal(momentById('cursor-calibration').app, false);
  assert.deepEqual(momentById('cursor-calibration').steps[1], { do: 'wait', ms: 25_000 });
  assert.equal(momentById('cursor-idle-fade').cursor?.tailSeconds, 20);
});

test('medianBackground and detectCursor find the cursor, mask the HUD and the dots, and give up on a flash', () => {
  const video = cursorVideo((t) => [60 + t / 20, 100], { count: 40, extra: (t, fill) => fill(250, 150, 30, 30, DOT_LUMA) });
  const bg = medianBackground(video, [0, 0, 320, 200]);
  assert.equal(bg[100 * 320 + 10], 235);
  const track = detectCursor(video, { rect: [0, 0, 320, 200] });
  assert.equal(track.filter((f) => f.found).length, 40);
  // the dot sits still in every frame, so it is background; the cursor is found at its centre to well under a pixel
  assert.ok(
    track.every((f) => Math.abs(f.x - (60.5 + f.t / 20)) < 1 && Math.abs(f.y - 100.5) < 1),
    JSON.stringify(track[5]),
  );
  assert.ok(track[5].n > 100 && track[5].m > 0);
  // an ignore rect hides the cursor; one outside the region ignores nothing; a disc hides only pixels of its luma
  const hidden = detectCursor(video, { rect: [0, 0, 320, 200], ignore: { rects: [[0, 80, 320, 40]] } });
  assert.equal(hidden.filter((f) => f.found).length, 0);
  const outside = detectCursor(video, { rect: [0, 0, 320, 200], ignore: { rects: [[1000, 1000, 5, 5]] } });
  assert.equal(outside.filter((f) => f.found).length, 40);
  const disc = { t0: 0, t1: 1e9, x: 80, y: 100, r: 30, luma: 40, tol: 3 };
  assert.equal(detectCursor(video, { rect: [0, 0, 320, 200], ignore: { discs: [disc] } })[0].found, false);
  assert.equal(detectCursor(video, { rect: [0, 0, 320, 200], ignore: { discs: [{ ...disc, luma: 200 }] } })[0].found, true);
  assert.equal(detectCursor(video, { rect: [0, 0, 320, 200], ignore: { discs: [{ ...disc, t0: 1e8, t1: 1e9 }] } })[0].found, true);
  // a full-region flash is not a cursor
  const flash = cursorVideo(() => null, { count: 30, extra: (t, fill) => t > 400 && t < 450 && fill(0, 0, 320, 200, 0) });
  const flashed = detectCursor(flash, { rect: [0, 0, 320, 200] });
  assert.ok(flashed.every((f) => !f.found));
  // a faint blob under the cell minimum is not found either
  const dust = cursorVideo(() => null, { count: 10, extra: (t, fill) => t > 50 && fill(5, 5, 1, 1, 0) });
  assert.ok(detectCursor(dust, { rect: [0, 0, 320, 200], minCells: 2 }).every((f) => !f.found));
  // a far stray blob is dropped by the reach; two blobs too far from their centre are all kept
  const stray = cursorVideo((t) => [60 + t / 20, 100], { count: 30, extra: (t, fill) => t > 200 && t < 300 && fill(100, 170, 4, 4, 0) });
  const strayed = detectCursor(stray, { rect: [0, 0, 320, 200], reach: 30 })[15];
  assert.ok(Math.abs(strayed.y - 100.5) < 2, `${strayed.y}`);
  assert.ok(detectCursor(stray, { rect: [0, 0, 320, 200], reach: 300 })[15].y > 103, 'without the reach the stray pulls the centre');
  const pair = cursorVideo((t) => [40 + t / 50, 100], { count: 30, extra: (t, fill) => fill(280 - Math.round(t / 50), 95, 12, 12, 40) });
  const paired = detectCursor(pair, { rect: [0, 0, 320, 200], reach: 20, maxShare: 0.9 }).at(-1)!;
  assert.ok(paired.found);
});

test('findMoves cuts a spring move at its settle points and ignores jitter, gaps and lost frames', () => {
  const move = moveOf([100, 100], [400, 100]);
  assert.ok(Math.abs(move.distance - 300) < 1.5);
  assert.ok(move.durationMs > 150 && move.durationMs < 1300, `${move.durationMs}`);
  assert.ok(move.peakSpeed > 500);
  assert.equal(move.start.x, move.points[0].x);
  // jitter under the minimum travel is not a move; neither is a standstill
  assert.equal(findMoves(trackOf((t) => [100 + (t < 50 ? t / 20 : 2.5), 100], 400)).length, 0);
  assert.equal(findMoves(trackOf(() => [100, 100], 400)).length, 0);
  // two moves with a still stretch between are two; a gap in the track closes the first
  const two = findMoves(
    trackOf((t) => (t < 800 ? springAt([100, 100], [300, 100], 0, t) : springAt([300, 100], [100, 200], 1000, t)), 2000),
    { settlePx: 0.2 },
  );
  assert.equal(two.length, 2);
  const gap = findMoves(trackOf((t) => (t > 300 && t < 600 ? null : springAt([100, 100], [500, 100], 0, t)), 1200));
  assert.ok(gap.length >= 1);
  // a move cut off by a lost frame, then restarted: the next move starts clean
  const lost = trackOf((t) => (t >= 400 && t <= 560 ? null : t < 400 ? [100 + t, 100] : [500 + (t - 560), 300]), 900);
  assert.ok(findMoves(lost).length >= 1);
  assert.equal(findMoves(trackOf(() => null, 200)).length, 0);
});

test('chordFrame, pathShape: straightness, sides, overshoot and when the speed peaks', () => {
  const straight = moveOf([100, 100], [400, 100]);
  const shape = pathShape(straight);
  assert.ok(shape.straightness! >= 1 && shape.straightness! < 1.05);
  assert.equal(shape.side, 'none');
  assert.equal(shape.deviationPx, 0);
  assert.ok(shape.peakAtShare! > 0 && shape.peakAtShare! < 0.5, `${shape.peakAtShare}`);
  assert.ok(shape.overshootPx! >= 0);
  const right = pathShape(moveOf([100, 100], [400, 100], { bulge: 0.2 }));
  const left = pathShape(moveOf([100, 100], [400, 100], { bulge: -0.2 }));
  assert.equal(right.side, 'right');
  assert.equal(left.side, 'left');
  assert.ok(right.deviationShare! > 0.1 && right.straightness! > 1.05);
  // an underdamped spring runs past its end
  assert.ok(pathShape(moveOf([100, 100], [400, 100], { damping: 0.4 })).overshootPx! > 5);
  const frame = chordFrame([
    { t: 5, x: 1, y: 1 },
    { t: 15, x: 4, y: 1 },
  ]);
  assert.deepEqual(frame, [
    { t: 0, u: 0, v: 0 },
    { t: 10, u: 3, v: 0 },
  ]);
  assert.deepEqual(
    chordFrame([
      { t: 0, x: 2, y: 2 },
      { t: 1, x: 2, y: 2 },
    ])[1],
    { t: 1, u: 0, v: 0 },
  );
});

test('updateRate: the cursor’s own redraw rate against the recorder’s, and when the recorder limits it', () => {
  const fast = findMoves(trackOf((t) => springAt([100, 100], [500, 100], 0, t), 1500));
  const rate = updateRate(fast);
  assert.equal(rate.captureLimited, true);
  assert.ok(Math.abs(rate.fps! - 60) < 2 && Math.abs(rate.captureFps! - 60) < 2);
  assert.ok(rate.updates.p95! >= rate.updates.p50!);
  // the cursor redraws at 30 Hz inside a 60 Hz recording
  const slow = findMoves(trackOf((t) => springAt([100, 100], [500, 100], 0, Math.floor(t / (2 * MS)) * 2 * MS), 1500));
  const slowRate = updateRate(slow);
  assert.equal(slowRate.captureLimited, false);
  assert.ok(Math.abs(slowRate.fps! - 30) < 2 && Math.abs(slowRate.captureFps! - 60) < 2);
  assert.ok(slowRate.updates.jitter! >= 0);
  assert.deepEqual(updateRate([]), {
    updates: { count: 0, p50: null, p95: null, max: null, jitter: null },
    capture: { count: 0, p50: null, p95: null, max: null, jitter: null },
    fps: null,
    captureFps: null,
    captureLimited: false,
  });
});

test('matchMoves pairs expected moves with found ones in order and leaves the unfound null', () => {
  const a = moveOf([100, 100], [300, 100]);
  const found = [a];
  const exp = [
    { from: { x: 100, y: 100 }, to: { x: 300, y: 100 } },
    { from: { x: 300, y: 100 }, to: { x: 100, y: 100 } },
  ];
  const matched = matchMoves(found, exp);
  assert.equal(matched[0].move, a);
  assert.equal(matched[1].move, null);
  assert.equal(matchMoves(found, [{ from: { x: 0, y: 0 }, to: { x: 300, y: 100 } }])[0].move, null);
  assert.equal(matchMoves(found, [{ from: { x: 100, y: 100 }, to: { x: 0, y: 0 } }])[0].move, null);
});

test('idleFade: how long the cursor holds, then fades and goes', () => {
  const faded = trackOf(() => [50, 50], 2000).map((f) => ({
    ...f,
    found: f.t < 1400,
    m: f.t < 1000 ? 28000 : f.t < 1400 ? 28000 * (1 - (f.t - 1000) / 400) : 0,
  }));
  const fade = idleFade(faded, 500);
  assert.equal(fade.fullMass, 28000);
  assert.ok(fade.delayMs! >= 500 && fade.delayMs! <= 600, `${fade.delayMs}`);
  assert.ok(fade.fadeMs! > 250 && fade.fadeMs! <= 400, `${fade.fadeMs}`);
  assert.ok(Math.abs(fade.goneMs! - (fade.delayMs! + fade.fadeMs!)) < 0.2);
  // a cursor that vanishes in one frame has no fade, only a delay
  const abrupt = idleFade(
    trackOf((t) => (t < 1000 ? [50, 50] : null), 1500),
    500,
  );
  assert.deepEqual([abrupt.fadeMs, abrupt.delayMs! > 480 && abrupt.delayMs! < 530], [0, true]);
  assert.deepEqual(
    idleFade(
      trackOf(() => null, 500),
      400,
    ),
    { fullMass: null, delayMs: null, fadeMs: null, goneMs: null },
  );
  assert.deepEqual(
    idleFade(
      trackOf(() => [1, 1], 1500),
      500,
    ),
    { fullMass: 28000, delayMs: null, fadeMs: null, goneMs: null },
  );
  // fading that never finishes inside the recording
  const half = trackOf(() => [1, 1], 1500).map((f) => (f.t > 800 ? { ...f, m: 10000 } : f));
  assert.deepEqual(idleFade(half, 500), { fullMass: 28000, delayMs: 316.7, fadeMs: null, goneMs: null });
});

test('classicFixtureSource strips exports, keeps the rest and publishes the page names', () => {
  const out = classicFixtureSource(
    "export const A = 1;\nexport function f() {}\n  export x\nexport { A, f };\nexport {B}\nconst z = 'export ';\n",
  );
  assert.equal(
    out,
    "const A = 1;\nfunction f() {}\n  export x\n\n\nconst z = 'export ';\n\nwindow.__fixture = { planFor, calibrationPosition, TYPE_TEXT };\n",
  );
});

test('the real fixture module in classic form and the page script parse and run to the ready log', async () => {
  const { readFileSync } = await import('node:fs');
  const { createContext, runInContext } = await import('node:vm');
  const src = classicFixtureSource(readFileSync(new URL('../bench/lib/motion/fixture.mjs', import.meta.url), 'utf8'));
  const html = fixtureHtml();
  const inline = /<script>\n([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const sent: string[] = [];
  const el = () => ({
    style: {},
    remove() {},
    append() {},
    addEventListener() {},
    appendChild: (c: unknown) => c,
    parentNode: { appendChild: (c: unknown) => c },
  });
  const win: Record<string, unknown> = {
    location: { search: '?fixture=' + encodeURIComponent('{"plan":"move","distance":100}') },
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 2,
    screenX: 0,
    screenY: 0,
    outerWidth: 800,
    outerHeight: 600,
    document: { getElementById: el, createElement: el, body: el() },
    navigator: { sendBeacon: (_: string, b: string) => sent.push(b) },
    addEventListener() {},
    requestAnimationFrame() {},
    Object,
    Math,
    Date,
    JSON,
    URLSearchParams,
  };
  win.window = win;
  const ctx = createContext(win);
  // two classic scripts in one global scope, as the browser runs them
  runInContext(src, ctx);
  runInContext(inline, ctx);
  assert.deepEqual(sent.map((s) => JSON.parse(s).type).slice(0, 2), ['ready', 'show']);
});
