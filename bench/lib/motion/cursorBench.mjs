// Motion bench cursor recording analysis (#3810): one recording of a fixture moment joined with the fixture page's event log (ground truth) into cursor rate and jitter, move paths, the arc-and-spring fit, latencies, typing and scroll cadence, the idle fade and the calibration check.
import { appearEpisodes, summarizeAppear } from './appear.mjs';
import { detectCursor, findMoves, flatBackground, idleFade, matchMoves, pathShape, updateRate } from './cursor.mjs';
import { feedback } from './metrics.mjs';
import { BACKGROUND_LUMA, calibrationPosition, DOT_LUMA, DOT_RADIUS, expectedMoves, HUD_RECT, planFor } from './fixture.mjs';
import { compareToPlanner, fitMove, pathSummary } from './skyFit.mjs';
import { median, quantile, round, spread } from './stats.mjs';

/** @typedef {import('./frames.mjs').Video} Video */
/** @typedef {import('./frames.mjs').Rect} Rect */
/** @typedef {{ type: string, t: number, [k: string]: any }} PageEvent one line of the fixture page's log; `t` is the wall clock in ms */

const isNumber = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
const med = (/** @type {unknown[]} */ xs, places = 1) => round(median(/** @type {number[]} */ (xs.filter(isNumber))), places);

/**
 * The viewport's top left in source px from the page's own `ready` event: the window's place (`screenX`, `screenY`) plus
 * its frame, which is the outer size less the viewport (the side borders split evenly, the rest is on top: a title bar).
 * Null when the event is missing or reports no window place.
 */
export function readyOrigin(/** @type {PageEvent[]} */ events, /** @type {number} */ pxPerPoint) {
  const r = events.find((e) => e.type === 'ready');
  // the native fixture app reports its content view's top-left in screen points itself (a WKWebView has no outer window size)
  if (r?.frame && isNumber(r.frame.x) && isNumber(r.frame.y)) return { x: r.frame.x * pxPerPoint, y: r.frame.y * pxPerPoint };
  if (!r || !Array.isArray(r.viewport) || !['screenX', 'screenY', 'outerWidth', 'outerHeight'].every((k) => isNumber(r[k]))) return null;
  const side = (r.outerWidth - r.viewport[0]) / 2;
  return { x: (r.screenX + side) * pxPerPoint, y: (r.screenY + r.outerHeight - r.viewport[1] - side) * pxPerPoint };
}

/**
 * Screen points per CSS px of the page: 1 in a window, but an in-app browser pane can show the page zoomed (the fixture reports
 * `dpr` above 1 on a 1x display while 200 CSS px span 142 points). The slope of trusted clicks' screen against page position says it.
 */
export function pageScale(/** @type {PageEvent[]} */ events) {
  const c = events.filter((e) => e.type === 'click' && e.trusted && isNumber(e.sx) && isNumber(e.cx));
  const lo = c.reduce((a, e) => (e.cx < a.cx ? e : a), c[0]);
  const hi = c.reduce((a, e) => (e.cx > a.cx ? e : a), c[0]);
  if (!lo || hi.cx - lo.cx < 50) return 1;
  const s = (hi.sx - lo.sx) / (hi.cx - lo.cx);
  return Math.abs(s - 1) < 0.03 || !(s > 0.2 && s < 5) ? 1 : s;
}

/** How far (in points) the window guess and the clicks may differ before the clicks are trusted. */
const ORIGIN_DISAGREES = 12;

/** The viewport's top left in source px: the page's `ready` event, unless trusted clicks (`screenX - clientX`) say a browser pane sits elsewhere; null when neither reports it. */
export function originFromEvents(/** @type {PageEvent[]} */ events, /** @type {number} */ pxPerPoint) {
  const ready = readyOrigin(events, pxPerPoint);
  // the native fixture app's own report of its content view is exact
  if (events.some((e) => e.type === 'ready' && e.frame)) return ready;
  const clicks = clickOrigin(events, pxPerPoint);
  // a window's outer-size guess agrees with the clicks to a few px; an in-app browser pane sits inside its window, so the guess is off (77 px in the Codex app) and the clicks, which are measured, win
  if (ready && clicks && Math.hypot(ready.x - clicks.x, ready.y - clicks.y) > ORIGIN_DISAGREES * pxPerPoint) return clicks;
  return ready ?? clicks;
}

/** The viewport's top left in source px from trusted clicks (`screenX - clientX`); null when no click reports it. */
function clickOrigin(/** @type {PageEvent[]} */ events, /** @type {number} */ pxPerPoint) {
  const clicks = events.filter((e) => e.type === 'click' && e.trusted && isNumber(e.sx) && isNumber(e.cx) && e.sx !== e.cx);
  if (!clicks.length) return null;
  const scale = pageScale(events);
  return {
    x: /** @type {number} */ (median(clicks.map((e) => e.sx - e.cx * scale))) * pxPerPoint,
    y: /** @type {number} */ (median(clicks.map((e) => e.sy - e.cy * scale))) * pxPerPoint,
  };
}

/**
 * The viewport's top left fitted from where the cursor was at each click: the median of (cursor - click position). It
 * folds the cursor's hotspot offset into the origin, so landing errors from it are optimistic; the report says so.
 * @param {import('./cursor.mjs').Fix[]} track @param {{ t: number, cx: number, cy: number }[]} clicks video ms, CSS px
 */
export function fitOrigin(track, clicks, pxPerPoint) {
  const found = track.filter((f) => f.found);
  /** @type {{ x: number, y: number }[]} */
  const offsets = [];
  for (const c of clicks) {
    const near = found.filter((f) => Math.abs(f.t - c.t) <= 100).sort((a, b) => Math.abs(a.t - c.t) - Math.abs(b.t - c.t))[0];
    if (near) offsets.push({ x: near.x - c.cx * pxPerPoint, y: near.y - c.cy * pxPerPoint });
  }
  if (!offsets.length) return null;
  return { x: /** @type {number} */ (median(offsets.map((o) => o.x))), y: /** @type {number} */ (median(offsets.map((o) => o.y))) };
}

/**
 * The fixture dots as ignore discs: each dot is on screen from its `show` until the next one's, so its pixels are not cursor.
 * @param {PageEvent[]} events @param {(wall: number) => number} toVideo @param {{ x: number, y: number }} origin @param {number} k CSS px to source px
 */
export function dotDiscs(events, toVideo, origin, k) {
  const shows = events.filter((e) => e.type === 'show');
  const end = events.length ? Math.max(...events.map((e) => e.t)) : 0;
  return shows.map((e, i) => ({
    t0: toVideo(e.t) - 80,
    t1: toVideo(i + 1 < shows.length ? shows[i + 1].t : end) + (i + 1 < shows.length ? 80 : 1000),
    x: origin.x + e.x * k,
    y: origin.y + e.y * k,
    r: (DOT_RADIUS + 3) * k,
    luma: DOT_LUMA,
    tol: 14,
  }));
}

/**
 * Per-move results for the moves of a plan: matched to the cursor's moves, then shape, arc-and-spring fit, the reference
 * planner's error, the landing error and (with the page's clicks) the pause before, dwell and visible feedback.
 * @param {{ video: Video, plan: import('./fixture.mjs').Plan, moves: import('./cursor.mjs').Move[], origin: { x: number, y: number }, k: number,
 *   clicks: { t: number, hit: boolean, i: number }[] | null, planner: { planner: import('./skyFit.mjs').Planner, source: string }, bounds: [number, number] }} o
 */
export function analyzeMoves({ video, plan, moves, origin, k, clicks, planner, bounds }) {
  const at = (/** @type {{ x: number, y: number }} */ p) => ({ x: origin.x + p.x * k, y: origin.y + p.y * k });
  const expected = expectedMoves(plan).map((e) => ({ ...e, from: at(e.from), to: at(e.to) }));
  const matched = matchMoves(moves, expected);
  const hits = clicks ? clicks.filter((c) => c.hit) : [];
  const list = matched.map(({ expected: e, move }) => {
    const key = `${e.distance}@${e.angle}`;
    if (!move) return { key, index: e.index, distance: e.distance, angle: e.angle, matched: false };
    // the page's click on the dot this move ended on, and the one before it (the action that came before this move)
    const click = hits.find((c) => c.i === e.index) ?? null;
    const prev = hits.find((c) => c.i === e.index - 1) ?? null;
    return {
      key,
      index: e.index,
      distance: e.distance,
      angle: e.angle,
      matched: true,
      durationMs: round(move.durationMs),
      peakSpeed: round(move.peakSpeed),
      ...pathShape(move),
      landingPx: round(Math.hypot(move.end.x - e.to.x, move.end.y - e.to.y)),
      landing: { x: round(move.end.x - e.to.x), y: round(move.end.y - e.to.y) },
      thinkMs: prev ? round(move.t0 - prev.t) : null,
      dwellMs: click ? round(click.t - move.t1) : null,
      fit: fitMove(move),
      plan: compareToPlanner(move, planner.planner, bounds),
      path: pathSummary(move),
    };
  });
  return {
    list,
    matched: list.filter((m) => m.matched),
    moves: matched.flatMap((m) => (m.move ? [m.move] : [])),
    expected: expected.length,
  };
}

/**
 * The page's clicks: how many hit, the time between hits, and how long after each the page's counter changes on screen
 * (every click rewrites it): the click's effect as the recording shows it.
 * @param {{ t: number, hit: boolean }[]} clicks video ms @param {Video} video @param {Rect} hud
 */
export function analyzeClicks(clicks, video, hud) {
  const hits = clicks.filter((c) => c.hit);
  return {
    count: clicks.length,
    hits: hits.length,
    misses: clicks.length - hits.length,
    cycleMs: spread(hits.slice(1).map((c, i) => c.t - hits[i].t)),
    feedbackMs: med(hits.map((c) => feedback(video, { trigger: c.t, response: hud }).ms)),
  };
}

/** The key events of a typing moment: intervals between characters and the time from the first to the last. */
export function analyzeTyping(
  /** @type {PageEvent[]} */ events,
  /** @type {Video} */ video,
  /** @type {(wall: number) => number} */ toVideo,
  /** @type {Rect} */ field,
) {
  const keys = events.filter((e) => e.type === 'key');
  const submit = events.find((e) => e.type === 'submit') ?? null;
  const intervals = keys.slice(1).map((e, i) => e.t - keys[i].t);
  const echo = keys.length ? feedback(video, { trigger: toVideo(keys[0].t), response: field }).ms : null;
  return {
    keys: keys.length,
    submitted: submit ? submit.ok === true : null,
    intervalMs: spread(intervals),
    totalMs: keys.length ? keys[keys.length - 1].t - keys[0].t : null,
    echoMs: echo,
    enterAfterMs: submit && keys.length ? submit.t - keys[keys.length - 1].t : null,
  };
}

/** The scroll events of a scrolling moment: how often the page scrolled, in what steps, and how far in all. */
export function analyzeScroll(
  /** @type {PageEvent[]} */ events,
  /** @type {Video} */ video,
  /** @type {(wall: number) => number} */ toVideo,
  /** @type {Rect} */ view,
) {
  const scrolls = events.filter((e) => e.type === 'scroll');
  const intervals = scrolls.slice(1).map((e, i) => e.t - scrolls[i].t);
  const steps = scrolls.slice(1).map((e, i) => Math.abs(e.y - scrolls[i].y));
  return {
    events: scrolls.length,
    intervalMs: spread(intervals),
    stepPx: spread(steps),
    maxY: scrolls.length ? Math.max(...scrolls.map((e) => e.y)) : null,
    totalMs: scrolls.length ? scrolls[scrolls.length - 1].t - scrolls[0].t : null,
    visibleMs: scrolls.length ? feedback(video, { trigger: toVideo(scrolls[0].t), response: view }).ms : null,
  };
}

/**
 * What this recorder can see, from the known moving target: the recorder's frame intervals, and per phase the measured
 * speed and position error against the page's ground truth (after the best time shift of up to 100 ms, which is also the clock offset
 * between page and recording).
 * @param {import('./cursor.mjs').Fix[]} track @param {Extract<import('./fixture.mjs').Plan, { kind: 'calibration' }>} plan
 * @param {number} t0 video ms @param {{ x: number, y: number }} origin @param {number} k
 */
export function analyzeCalibration(track, plan, t0, origin, k) {
  const intervals = track.slice(1).map((f, i) => f.t - track[i].t);
  const p50 = quantile(intervals, 0.5);
  const found = track.filter((f) => f.found);
  const errors = (/** @type {number} */ shift) =>
    found.flatMap((f) => {
      const truth = calibrationPosition(plan, f.t - t0 - shift);
      return truth ? [Math.hypot(f.x - (origin.x + truth.x * k), f.y - (origin.y + truth.y * k))] : [];
    });
  let shift = 0;
  let best = errors(0).length ? Math.sqrt(errors(0).reduce((s, e) => s + e * e, 0) / errors(0).length) : Number.POSITIVE_INFINITY;
  for (let s = -100; s <= 100; s += 2) {
    const e = errors(s);
    const r = e.length ? Math.sqrt(e.reduce((a, v) => a + v * v, 0) / e.length) : Number.POSITIVE_INFINITY;
    if (r < best - 1e-9) {
      best = r;
      shift = s;
    }
  }
  const phases = plan.phases.map((phase, index) => {
    const speeds = [];
    for (let i = 1; i < found.length; i += 1) {
      const mid = (found[i].t + found[i - 1].t) / 2 - t0 - shift;
      const dt = found[i].t - found[i - 1].t;
      // a step inside one phase and away from its turns (the target reverses at the ends)
      if (Math.floor(mid / 6000) === index && dt < 100 && Math.abs(found[i].x - found[i - 1].x) > 0.3 * ((phase.speed * k * dt) / 1000)) {
        speeds.push((Math.hypot(found[i].x - found[i - 1].x, found[i].y - found[i - 1].y) / dt) * 1000);
      }
    }
    const measured = median(speeds);
    return {
      speed: phase.speed,
      measuredSpeed: measured === null ? null : round(measured / k),
      errorShare: measured === null ? null : round(Math.abs(measured / k - phase.speed) / phase.speed, 3),
    };
  });
  return {
    recorder: {
      intervalMs: spread(intervals),
      fps: p50 ? round(1000 / p50) : null,
      droppedShare: p50 ? round(intervals.filter((i) => i > 1.5 * p50).length / intervals.length, 3) : null,
    },
    clockOffsetMs: shift,
    positionRmsPx: Number.isFinite(best) ? round(best, 2) : null,
    foundShare: track.length ? round(found.length / track.length, 3) : null,
    phases,
  };
}

/**
 * Analyses one cursor-moment recording.
 * @param {{ video: Video, events: PageEvent[], toVideo: ((wall: number) => number) | null, pxPerPoint: number, marks?: Record<string, number>,
 *   planner: { planner: import('./skyFit.mjs').Planner, source: string }, results?: any[], origin?: { x: number, y: number } | null, screen?: [number, number], labelled?: boolean }} o
 *   `results` are the generic measure() results of the same recording (dead air and overlay cadence)
 */
export function analyzeCursor({
  video,
  events,
  toVideo,
  pxPerPoint,
  marks = {},
  planner,
  results = [],
  origin: given = null,
  labelled = false,
  screen = video.source,
}) {
  const k = pxPerPoint * pageScale(events);
  const notes = /** @type {string[]} */ ([]);
  const ready = events.find((e) => e.type === 'ready') ?? null;
  const plan = ready ? planFor(ready.fixture, ready.viewport) : null;
  if (!plan) notes.push('the page logged no ready event: no plan, no ground truth');
  if (!toVideo) notes.push('clock sync not seen: page events are not joined with the recording');
  let origin = given ?? originFromEvents(events, pxPerPoint);
  let originFrom = given ? 'given' : origin ? 'events' : null;
  const whole = /** @type {Rect} */ ([0, 0, screen[0], screen[1]]);
  const viewport = ready ? /** @type {[number, number]} */ (ready.viewport) : null;
  const clicks = toVideo
    ? events.filter((e) => e.type === 'click').map((e) => ({ t: toVideo(e.t), hit: e.hit === true, i: e.i, cx: e.cx, cy: e.cy }))
    : null;
  const box = (/** @type {{ x: number, y: number }} */ o, /** @type {[number, number, number, number]} */ r) =>
    /** @type {Rect} */ ([o.x + r[0] * k, o.y + r[1] * k, r[2] * k, r[3] * k]);
  const hudOf = (/** @type {{ x: number, y: number }} */ o) => box(o, HUD_RECT);
  const [vw, vh] = viewport ?? [0, 0];
  const viewOf = (/** @type {{ x: number, y: number }} */ o) => box(o, [0, 0, vw, vh]);
  // with the page's place known, the cursor is whatever differs from the page's own flat background inside its viewport (a cursor that rests is found too);
  // the counter, the typing field and a scrolling page's content are not cursor
  const detectIn = (/** @type {{ x: number, y: number }} */ o) => {
    const view = viewOf(o);
    const rects = [hudOf(o)];
    if (plan?.kind === 'type') rects.push(box(o, [plan.field.x - 4, plan.field.y - 4, plan.field.w + 8, plan.field.h + 8]));
    if (plan?.kind === 'scroll') rects.push(view);
    return detectCursor(video, {
      rect: view,
      background: flatBackground(video, view, BACKGROUND_LUMA),
      ignore: { rects, discs: toVideo ? dotDiscs(events, toVideo, o, k) : [] },
    });
  };
  // without it, the cursor is whatever differs from the median of the frames
  let track = origin && viewport ? detectIn(origin) : detectCursor(video, { rect: whole });
  if (!origin && clicks && viewport) {
    // no trusted click reported the window's place (a CDP page, a pane): fit it from where the cursor was at each click
    origin = fitOrigin(
      track,
      clicks.filter((c) => c.hit),
      k,
    );
    if (origin) {
      originFrom = 'fit';
      notes.push('origin fitted from the cursor at each click: landing errors fold in the hotspot offset');
      track = detectIn(origin);
    }
  }
  const moves = findMoves(track);
  const found = track.filter((f) => f.found).length;
  const send = marks.send ?? video.frames[0]?.t ?? 0;
  const bounds = /** @type {[number, number]} */ ([screen[0] / k, screen[1] / k]);
  const moved =
    plan && origin && (plan.kind === 'move' || plan.kind === 'repeat')
      ? analyzeMoves({ video, plan, moves, origin, k, clicks, planner, bounds })
      : null;
  const measured = moved ? moved.matched : [];
  const rate = updateRate(moved?.moves.length ? moved.moves : moves);
  const air = results.find((r) => r.kind === 'deadAir' && !r.error);
  const cad = results.find((r) => r.kind === 'cadence' && !r.error);
  const lastEvent = Math.max(0, ...events.filter((e) => e.type !== 'ready').map((e) => e.t));
  const calib = events.find((e) => e.type === 'calib');
  const firstMove = moves[0]?.t0 ?? null;
  const firstClick = clicks?.find((c) => c.hit)?.t ?? null;
  const first = /** @type {number[]} */ ([firstMove, firstClick].filter(isNumber));
  const clickStats = clicks && origin ? analyzeClicks(clicks, video, hudOf(origin)) : null;
  const fits = measured.map((m) => /** @type {any} */ (m).fit);
  const planned = measured.map((m) => /** @type {any} */ (m).plan);
  const viewRect = origin && viewport ? viewOf(origin) : whole;
  const fieldRect = plan?.kind === 'type' && origin ? box(origin, [plan.field.x, plan.field.y, plan.field.w, plan.field.h]) : viewRect;
  const calibration =
    plan?.kind === 'calibration' && origin && toVideo && calib ? analyzeCalibration(track, plan, toVideo(calib.t), origin, k) : null;
  return {
    plan: plan ? { kind: plan.kind, skipped: 'skipped' in plan ? plan.skipped : [] } : null,
    viewport,
    origin: origin ? { x: round(origin.x), y: round(origin.y), from: originFrom } : null,
    track: { frames: track.length, foundShare: round(found / Math.max(1, track.length), 3), moves: moves.length },
    cursor: rate,
    clicks: clickStats,
    appear: origin && viewport ? summarizeAppear(appearEpisodes({ video, events, toVideo, origin, k, planner, bounds, labelled })) : null,
    moves: {
      expected: moved?.expected ?? null,
      matched: measured.length,
      durationMs: med(measured.map((m) => /** @type {any} */ (m).durationMs)),
      straightness: med(
        measured.map((m) => /** @type {any} */ (m).straightness),
        3,
      ),
      list: moved ? moved.list : [],
    },
    fit: {
      rmsPx: med(
        fits.map((f) => f.rmsPx),
        2,
      ),
      p95Px: med(
        fits.map((f) => f.p95Px),
        2,
      ),
      response: med(
        fits.map((f) => f.response),
        3,
      ),
      damping: med(
        fits.map((f) => f.damping),
        3,
      ),
      arcGainPx: med(
        fits.map((f) => f.arcGainPx),
        2,
      ),
      planner: {
        source: planner.source,
        rmsPx: med(
          planned.map((p) => p.rmsPx),
          2,
        ),
        offsetMs: med(planned.map((p) => p.offsetMs)),
        durationRatio: med(
          planned.map((p) => p.durationRatio),
          3,
        ),
      },
    },
    latency: {
      firstActionMs: first.length ? round(Math.min(...first) - send) : null,
      thinkMs: med(measured.map((m) => /** @type {any} */ (m).thinkMs)),
      dwellMs: med(measured.map((m) => /** @type {any} */ (m).dwellMs)),
      feedbackMs: clickStats?.feedbackMs ?? null,
      cycleMs: clickStats?.cycleMs.p50 ?? null,
    },
    gaps: air ? { longestMs: air.longestMs, count: air.gaps.length, list: air.gaps } : null,
    overlay: cad ? { updates: cad.updates, updatesPerSecond: cad.perSecond, medianMs: cad.medianMs } : null,
    typing: plan?.kind === 'type' && toVideo ? analyzeTyping(events, video, toVideo, fieldRect) : null,
    scroll: plan?.kind === 'scroll' && toVideo ? analyzeScroll(events, video, toVideo, viewRect) : null,
    idle: plan?.kind === 'idle' && toVideo && lastEvent ? idleFade(track, toVideo(lastEvent)) : null,
    calibration,
    notes,
  };
}
