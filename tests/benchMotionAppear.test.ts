// Motion bench appear-at-target episodes (bench/lib/motion/appear.mjs): the cursor blob near a dot, an episode cut from a run of frames, its numbers and fits, the aggregate and its place in analyzeCursor and the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPEAR, appearEpisodes, blobIn, episodeRun, fitEpisode, summarizeAppear, summarizeEpisode } from '../bench/lib/motion/appear.mjs';
import { analyzeCursor } from '../bench/lib/motion/cursorBench.mjs';
import { DOT_LUMA } from '../bench/lib/motion/fixture.mjs';
import { APPEAR_ROWS, formatReport, momentReport } from '../bench/lib/motion/report.mjs';
import { springStep, stubPlanner } from '../bench/lib/motion/skyFit.mjs';
import { cursorVideo, drawDisc, fixtureRun, ORIGIN, PAGE_LUMA, WALL0 } from './support/motionCursor.ts';

const planner = { planner: stubPlanner, source: 'stub' };
const bounds: [number, number] = [400, 300];
const geom = (o: Record<string, unknown> = {}) => ({ dot: { x: 100, y: 100 }, k: 1, ignoreDiscs: [], ignoreRects: [], ...o });
/** One frame of the page with `extra` drawn on it, blob-detected around a dot at (100, 100). */
const blob = (
  extra: (fill: (x: number, y: number, w: number, h: number, v: number) => void) => void,
  o: Record<string, unknown> = {},
  scale = 1,
) => {
  const video = cursorVideo(() => null, { count: 1, scale, extra: (_t, fill) => extra(fill) });
  return blobIn(video, video.frames[0].px, geom(o));
};

test('blobIn finds the cursor near the dot, allows for the dot or the bare page under it, and skips what is ignored or not cursor', () => {
  const dot = (fill: (x: number, y: number, w: number, h: number, v: number) => void) => fill(89, 89, 22, 22, DOT_LUMA);
  // a grey disc over the dot: its halo and glyph are the blob, and its centre is the dot's
  const covered = blob((fill) => {
    dot(fill);
    drawDisc(fill, 100, 100, 18);
  });
  assert.ok(covered && Math.abs(covered.x - 100) < 2 && Math.abs(covered.y - 100) < 2, JSON.stringify(covered));
  // a blob wider than a cursor is not one, unless the pointer carries a label chip (labelled recordings allow it)
  const wide = (fill: (x: number, y: number, w: number, h: number, v: number) => void) => fill(120, 90, 120, 20, 40);
  assert.equal(blob(wide), null);
  assert.ok(blob(wide, { extent: APPEAR.labelledExtent }));
  // the dot alone (and the page without it, as after the click) is nothing
  assert.equal(blob(dot), null);
  assert.equal(
    blob(() => {}),
    null,
  );
  // an arrow-sized dark square away from the dot, at scale 2 as the real recordings are decoded
  const away = blob((fill) => fill(150, 120, 12, 12, 40), {}, 2);
  assert.ok(away && Math.abs(away.x - 156) < 3 && Math.abs(away.y - 126) < 3, JSON.stringify(away));
  // ignored: a rect, a disc; too small; too wide for a cursor; outside the reach
  const square = (fill: (x: number, y: number, w: number, h: number, v: number) => void) => fill(150, 120, 12, 12, 40);
  assert.equal(blob(square, { ignoreRects: [[140, 110, 40, 40]] }), null);
  assert.equal(blob(square, { ignoreDiscs: [{ x: 156, y: 126, r: 12 }] }), null);
  assert.equal(
    blob((fill) => fill(150, 120, 3, 3, 40)),
    null,
  );
  assert.equal(
    blob((fill) => fill(10, 130, 200, 6, 40)),
    null,
  );
  assert.equal(
    blob((fill) => fill(10, 10, 12, 12, 40), { dot: { x: 300, y: 250 } }),
    null,
  );
  // the biggest group wins
  const two = blob((fill) => {
    fill(150, 60, 12, 12, 40);
    fill(150, 130, 16, 16, 40);
  });
  assert.ok(two && Math.abs(two.y - 138) < 2, JSON.stringify(two));
});

const seenAt = (t: number, x: number, y: number, m = 3000) => ({ t, x, y, n: 150, m });

test('episodeRun takes the run that ends nearest the click and is long enough, and bridges one-frame gaps', () => {
  assert.deepEqual(episodeRun([]), []);
  const early = [-700, -683, -666].map((t) => seenAt(t, 1, 1));
  const late = [-300, -283, -266, -200, -183, -166, -150, -133, -117, -100].map((t) => seenAt(t, 2, 2));
  const run = episodeRun([...early, ...late]);
  assert.equal(run.length, 10, 'the 70 ms gap is bridged, the 450 ms one is not');
  assert.equal(run[0].t, -300);
  // two frames are not an episode; one that ended 400 ms before the click is not this click's
  assert.deepEqual(episodeRun([seenAt(0, 1, 1), seenAt(17, 1, 1)]), []);
  assert.deepEqual(episodeRun(early), []);
  // a run that starts after the click is not either
  assert.deepEqual(episodeRun([200, 217, 233].map((t) => seenAt(t, 1, 1))), []);
});

/** An episode on a spring from `from` to the dot at (100, 100): frames every 16.7 ms from -`lead` ms to `last` ms, the blob's mass settling after the arrival. */
const springRun = (from: [number, number], lead = 300, last = 17, mass = (t: number) => 3500) => {
  const out: ReturnType<typeof seenAt>[] = [];
  for (let t = -lead; t <= last; t += 1000 / 60) {
    const p = springStep((t + lead) / 1000, 0.2, 0.9);
    out.push(seenAt(t, from[0] + (100 - from[0]) * p, from[1] + (100 - from[1]) * p, mass(t)));
  }
  return out;
};

test('summarizeEpisode reads the appear time, start, path shape, speed, settle, plateau and press of a spring move', () => {
  const run = springRun([200, 160], 300, 17, (t) => (t < -150 ? 5000 : t > 5 ? 2500 : 3500));
  const ep = summarizeEpisode(run, { x: 100, y: 100 }, 16.7);
  assert.equal(ep.usable, true);
  assert.equal(ep.censored, false);
  assert.equal(ep.visibleBeforeMs, 300);
  assert.ok(Math.abs(ep.startDistance - 116.6) < 1, String(ep.startDistance));
  assert.ok(ep.travelMs! > 100 && ep.travelMs! < 300, String(ep.travelMs));
  assert.ok(ep.straightness! > 0.99 && ep.lateralPx! < 1, `${ep.straightness} ${ep.lateralPx}`);
  assert.ok(ep.peakFraction! < 0.3 && ep.peakSpeed! > 300);
  assert.ok(Math.abs(ep.lingerMs - 17) < 1);
  assert.ok(ep.endOffset < 1);
  assert.ok(ep.discOnsetMs <= -100 && ep.discOnsetMs >= -170, String(ep.discOnsetMs));
  assert.ok(ep.pressMs !== null && ep.pressMs > 0, 'the mass drop after the click');
  assert.equal(ep.path.length, run.length);
  assert.equal(ep.speeds.length, ep.travel.length - 1);
});

test('summarizeEpisode: a cursor that was already there has no path, one visible at the window start is censored, no press without a departure', () => {
  const still = [-100, -83, -66, -50, -33, -16, 0].map((t) => seenAt(t, 101, 100));
  const ep = summarizeEpisode(still, { x: 100, y: 100 }, 16.7);
  assert.equal(ep.usable, false);
  assert.deepEqual([ep.travelMs, ep.straightness, ep.lateralPx, ep.peakSpeed, ep.peakFraction], [null, null, null, null, null]);
  assert.equal(ep.pressMs, null);
  assert.equal(ep.lingerMs, 0);
  // a move that settles 40 px from the dot is a move but not a usable one
  const wrong = springRun([200, 100], 300).map((f) => ({ ...f, x: f.x + 40 }));
  assert.equal(summarizeEpisode(wrong, { x: 100, y: 100 }, 16.7).usable, false);
  // visible from the first frame of the window
  const early = springRun([200, 100], 800);
  assert.equal(summarizeEpisode(early, { x: 100, y: 100 }, 16.7).censored, true);
  // a straight run of equal steps has a peak at its start and a zero chord guard
  const jump = [seenAt(-50, 100, 100), seenAt(-33, 100, 100), seenAt(-16, 100, 100)];
  assert.equal(summarizeEpisode(jump, { x: 100, y: 100 }, 16.7).straightness, null);
});

test('fitEpisode compares with the planner after the best shift and fits a generic spring', () => {
  const ep = summarizeEpisode(springRun([300, 180], 400), { x: 100, y: 100 }, 16.7);
  const fit = fitEpisode(ep, { x: 100, y: 100 }, stubPlanner, [800, 600]);
  assert.ok(Number.isFinite(fit.plan.rmsPx) && fit.plan.plannedMs > 0 && fit.plan.settleMs > 0, JSON.stringify(fit.plan));
  assert.ok(Math.abs(fit.plan.offsetMs) <= 150);
  assert.equal(typeof fit.plan.withinTravel, 'boolean');
  assert.ok(Math.abs(fit.spring.response - 0.2) < 0.06, JSON.stringify(fit.spring));
  assert.ok(fit.spring.rmsPx < 3);
  // a straight move in the planner's own time needs no shift
  const plan = stubPlanner({ x: 150, y: 100 }, { x: 100, y: 100 }, bounds);
  const exact = summarizeEpisode(
    Array.from({ length: 20 }, (_, i) => {
      const p = plan.positionAt(i * 16.7 + 16.7 * 0);
      return seenAt(-400 + i * 16.7, p.x, p.y);
    }),
    { x: 100, y: 100 },
    16.7,
  );
  assert.equal(fitEpisode(exact, { x: 100, y: 100 }, stubPlanner, bounds).plan.offsetMs, 0);
});

test('appearEpisodes cuts one episode per click out of a recording whose cursor shows only near each click', () => {
  const { video, events, abs } = fixtureRun(true, true);
  const toVideo = (w: number) => w - WALL0;
  const list = appearEpisodes({ video, events, toVideo, origin: ORIGIN, k: 1, planner, bounds });
  assert.equal(list.length, abs.length);
  const found = list.filter((e: any) => e.found);
  assert.equal(found.length, abs.length, JSON.stringify(list.map((e: any) => e.found)));
  for (const e of found as any[]) {
    assert.ok(e.usable && e.hit && e.fit, JSON.stringify(e));
    assert.ok(e.visibleBeforeMs > 250 && e.visibleBeforeMs <= 400, String(e.visibleBeforeMs));
    assert.ok(e.startDistance > 50 && e.startDistance <= 81, String(e.startDistance));
    assert.ok(e.lingerMs <= 34 && e.endOffset < 10, `${e.lingerMs} ${e.endOffset}`);
    assert.ok(Math.abs(e.fit.spring.response - 0.2) < 0.08, JSON.stringify(e.fit.spring));
  }
  // no clock or origin: nothing; a click with no dot shown before it; an untrusted click is left out
  assert.deepEqual(appearEpisodes({ video, events, toVideo: null, origin: ORIGIN, k: 1, planner, bounds }), []);
  assert.deepEqual(appearEpisodes({ video, events, toVideo, origin: null, k: 1, planner, bounds }), []);
  const noDot = events.filter((e: any) => e.type !== 'show');
  assert.deepEqual(appearEpisodes({ video, events: noDot, toVideo, origin: ORIGIN, k: 1, planner, bounds }), []);
  const untrusted = events.map((e: any) => (e.type === 'click' && e.i === 0 ? { ...e, trusted: false } : e));
  assert.equal(appearEpisodes({ video, events: untrusted, toVideo, origin: ORIGIN, k: 1, planner, bounds }).length, abs.length - 1);
  // a dot shown only by time (no click index match) is the last one before the click; a missed click has no episode
  const bare = events.map((e: any) => (e.type === 'click' ? { ...e, i: undefined, hit: undefined } : e));
  const bareList = appearEpisodes({ video, events: bare, toVideo, origin: ORIGIN, k: 1, planner, bounds });
  assert.equal(bareList.length, abs.length);
  assert.equal(bareList[0].hit, false);
  const still = fixtureRun(true, false);
  const quiet = appearEpisodes({ video: still.video, events: still.events, toVideo, origin: ORIGIN, k: 1, planner, bounds });
  assert.ok(quiet.length === abs.length);
});

test('a cursor that never shows has no episode; one visible only for a frame or two has no usable path', () => {
  const { events, abs } = fixtureRun(true, true);
  const empty = cursorVideo(() => null, {
    w: 400,
    h: 300,
    count: 200,
    fps: 30,
    extra: (ms, fill) => fill(0, 0, 400, 300, PAGE_LUMA + 0 * ms),
  });
  const list = appearEpisodes({ video: empty, events, toVideo: (w) => w - WALL0, origin: ORIGIN, k: 1, planner, bounds });
  assert.deepEqual(list[0], { index: 0, hit: true, found: false });
  assert.equal(list.length, abs.length);
  assert.equal(summarizeAppear(list).found, 0);
  // a one-frame recording has no frame interval and still answers
  const one = cursorVideo(() => null, { w: 400, h: 300, count: 1 });
  assert.equal(appearEpisodes({ video: one, events, toVideo: (w) => w - WALL0, origin: ORIGIN, k: 1, planner, bounds }).length, abs.length);
});

test('summarizeAppear gives medians and p95 of the episodes, counts what was usable, and copes with none', () => {
  const none = summarizeAppear([]);
  assert.deepEqual([none.clicks, none.found, none.usable, none.plan.withinTravel], [0, 0, 0, null]);
  assert.equal(none.travelMs.p50, null);
  const { video, events } = fixtureRun(true, true);
  const list = appearEpisodes({ video, events, toVideo: (w) => w - WALL0, origin: ORIGIN, k: 1, planner, bounds });
  const s = summarizeAppear([...list, { index: 99, hit: true, found: false }]);
  assert.equal(s.clicks, list.length + 1);
  assert.equal(s.found, list.length);
  assert.equal(s.usable, list.length);
  assert.equal(s.visibleBeforeMs.n, list.length);
  assert.ok(s.visibleBeforeMs.p50! > 250 && s.straightness.p50! > 0.9);
  assert.ok(s.plan.withinTravel !== null && s.spring.response.p50! > 0.1);
  assert.equal(APPEAR.before, 800);
});

test('analyzeCursor carries the appear summary; the report prints it for each side', () => {
  const { video, events } = fixtureRun(true, true);
  const a = analyzeCursor({ video, events, toVideo: (w) => w - WALL0, pxPerPoint: 1, marks: { send: 200 }, planner });
  assert.equal(a.appear?.found, a.appear?.clicks);
  assert.ok(a.appear && a.appear.usable > 0);
  const bare = analyzeCursor({ video, events: [], toVideo: null, pxPerPoint: 1, planner });
  assert.equal(bare.appear, null);
  const text = formatReport([momentReport('cursor-move-d100', { appear: a.appear }, { appear: null })], {
    vendor: 'ChatGPT',
    ours: 'MoPilot',
  });
  assert.match(text, /\| Appear at target \| ChatGPT \| MoPilot \|/);
  assert.match(text, /Visible before the click \(p50 \/ p95\) \(ms\) \| \d+/);
  assert.match(text, /\| — \|/);
  assert.equal(APPEAR_ROWS.length, 11);
  assert.doesNotMatch(formatReport([momentReport('m', {}, {})], { vendor: 'A', ours: 'B' }), /Appear at target/);
});

test('a pointer that shows only after the click (parked on the dot already) has no approach to measure and is not an error', () => {
  const { video, events, abs } = fixtureRun(true, true);
  // the clock reads every click 410 ms early, so the whole approach falls after it
  const late = appearEpisodes({ video, events, toVideo: (w: number) => w - WALL0 - 410, origin: ORIGIN, k: 1, planner, bounds });
  assert.equal(late.length, abs.length);
  assert.ok(
    late.some((e: any) => !e.found),
    JSON.stringify(late.map((e: any) => e.found)),
  );
  assert.ok(late.every((e: any) => e.found === false || e.visibleBeforeMs >= 0));
});

test('a pointer with a label chip beside it (labelled) is moved by the offset its blob settles at, so its path ends on the dot', () => {
  const { video, events, abs } = fixtureRun(true, true);
  const toVideo = (w: number) => w - WALL0;
  const plain = appearEpisodes({ video, events, toVideo, origin: ORIGIN, k: 1, planner, bounds });
  const labelled = appearEpisodes({ video, events, toVideo, origin: ORIGIN, k: 1, planner, bounds, labelled: true });
  assert.equal(labelled.length, abs.length);
  for (const [i, e] of (labelled as any[]).entries()) {
    assert.equal(e.found, plain[i].found);
    if (e.found) assert.equal(e.endOffset, 0, 'the settle point is the dot');
  }
});
