// Motion bench appear-at-target episodes (#3810): for each trusted click, the agent cursor's visible episode (a cursor that fades in near its target, moves in, presses and goes) cut from the recording, its path, timings and fit against the shared planner and a generic spring.
import { BACKGROUND_LUMA, DOT_LUMA, DOT_RADIUS, HUD_RECT } from './fixture.mjs';
import { fitMove, springStep } from './skyFit.mjs';
import { median, quantile, rms, round } from './stats.mjs';

/** @typedef {import('./frames.mjs').Video} Video */
/** @typedef {{ x: number, y: number }} Xy */
/** @typedef {{ t: number, x: number, y: number, n: number, m: number }} Seen one frame's cursor blob: ms from the click, centre in points, size (cells) and mass (luma change summed) */

/** Defaults: window around the click (ms), luma change that counts as cursor, smallest blob (cells), reach from the dot (points), largest blob extent (points), longest gap inside one episode (ms). */
export const APPEAR = {
  before: 800,
  // MOTION_APPEAR_AFTER widens the window after the click for a cursor that lingers (a vendor's, on a run whose next action is seconds away); a run with clicks closer than that must keep the default
  after: Number(process.env.MOTION_APPEAR_AFTER) || 300,
  delta: 12,
  minCells: 12,
  reach: 150,
  extent: 90,
  labelledExtent: 400,
  gapMs: 90,
  arriveRadius: 4,
  pressShare: 0.15,
  settleShare: 0.08,
  settledPx: 10,
};

/**
 * The cursor blob in one frame: the largest connected group of cells that differ from the page's flat background (with
 * the click's dot (or its absence) allowed for) by APPEAR.delta, near the dot, minus ignored discs and rects.
 * @param {Video} video @param {Uint8Array} px @param {{ dot: Xy, k: number, ignoreDiscs: (Xy & { r: number })[], ignoreRects: [number, number, number, number][], extent?: number }} g
 *   positions in source px; `k` source px per point
 * @returns {{ n: number, m: number, x: number, y: number } | null} centre in source px
 */
export function blobIn(video, px, { dot, k, ignoreDiscs, ignoreRects, extent: maxExtent = APPEAR.extent }) {
  const s = video.scale;
  const reach = Math.floor((APPEAR.reach * k) / s);
  const cx = dot.x / s;
  const cy = dot.y / s;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const x1 = Math.min(video.width, Math.ceil(cx + reach));
  const y1 = Math.min(video.height, Math.ceil(cy + reach));
  const w = x1 - x0;
  const h = y1 - y0;
  const rDot = (DOT_RADIUS * k) / s;
  const hot = new Float32Array(w * h);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (ignoreRects.some((r) => x * s >= r[0] && x * s < r[0] + r[2] && y * s >= r[1] && y * s < r[1] + r[3])) continue;
      if (ignoreDiscs.some((d) => Math.hypot(x * s - d.x, y * s - d.y) <= d.r)) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const v = px[y * video.width + x];
      let diff = Math.abs(v - BACKGROUND_LUMA);
      if (d <= rDot + 1.5) {
        // the dot's edge is anti-aliased and the page hides the dot at the click: only its flat inside is compared, with either the dot or the page
        if (d > rDot - 1.5) continue;
        diff = Math.min(diff, Math.abs(v - DOT_LUMA));
      }
      if (diff > APPEAR.delta) hot[(y - y0) * w + (x - x0)] = diff;
    }
  }
  // the biggest 8-connected group
  const seen = new Uint8Array(w * h);
  /** @type {{ n: number, m: number, x: number, y: number } | null} */
  let best = null;
  for (let i = 0; i < w * h; i += 1) {
    if (!hot[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let n = 0;
    let m = 0;
    let sx = 0;
    let sy = 0;
    let [lx, hx, ly, hy] = [w, 0, h, 0];
    while (stack.length) {
      const j = /** @type {number} */ (stack.pop());
      const [jx, jy] = [j % w, Math.floor(j / w)];
      n += 1;
      m += hot[j];
      sx += (jx + x0 + 0.5) * hot[j];
      sy += (jy + y0 + 0.5) * hot[j];
      [lx, hx, ly, hy] = [Math.min(lx, jx), Math.max(hx, jx), Math.min(ly, jy), Math.max(hy, jy)];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const [nx, ny] = [jx + dx, jy + dy];
          const q = ny * w + nx;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && hot[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    const extent = (Math.max(hx - lx, hy - ly) + 1) * (s / k);
    if (n >= APPEAR.minCells && extent <= maxExtent && (!best || n > best.n)) best = { n, m, x: (sx / m) * s, y: (sy / m) * s };
  }
  return best;
}

/**
 * The run of frames (gaps up to APPEAR.gapMs) that ends nearest the click and starts before it: the cursor's episode.
 * @param {Seen[]} seen frames with a cursor blob, time order @returns {Seen[]}
 */
export function episodeRun(seen) {
  /** @type {Seen[][]} */
  const runs = [];
  for (const f of seen) {
    const run = runs[runs.length - 1];
    if (run && f.t - run[run.length - 1].t <= APPEAR.gapMs) run.push(f);
    else runs.push([f]);
  }
  const near = runs.filter((r) => r[0].t <= 100 && r[r.length - 1].t >= -150 && r.length >= 3);
  return near.length ? near[near.length - 1] : [];
}

/**
 * One episode's numbers from its blob frames: when it appears and goes, where it starts, the path to where it settles,
 * the speed profile, how straight the path is, when it presses.
 * @param {Seen[]} run @param {Xy} dot centre in points @param {number} frameMs the recording's frame interval
 */
export function summarizeEpisode(run, dot, frameMs) {
  const first = run[0];
  const last = run[run.length - 1];
  const pre = run.filter((f) => f.t <= 0);
  // the settle point: the median of the last three frames before the click
  const tail = pre.slice(-3);
  const end = { x: /** @type {number} */ (median(tail.map((f) => f.x))), y: /** @type {number} */ (median(tail.map((f) => f.y))) };
  const dist = (/** @type {Xy} */ a, /** @type {Xy} */ b) => Math.hypot(a.x - b.x, a.y - b.y);
  // arrival: the first frame after which the cursor stays within arriveRadius of where it settles
  let arrive = pre.length - 1;
  while (arrive > 0 && dist(pre[arrive - 1], end) <= APPEAR.arriveRadius) arrive -= 1;
  const travel = pre.slice(0, arrive + 1);
  const speeds = travel.slice(1).map((f, i) => ({ t: (f.t + travel[i].t) / 2, v: (dist(f, travel[i]) / (f.t - travel[i].t)) * 1000 }));
  const peak = speeds.reduce((b, s) => (s.v > b.v ? s : b), { t: first.t, v: 0 });
  const travelMs = travel[travel.length - 1].t - first.t;
  const chord = dist(first, end);
  let length = 0;
  for (let i = 1; i < travel.length; i += 1) length += dist(travel[i], travel[i - 1]);
  // sideways deviation from the chord
  const ux = (end.x - first.x) / (chord || 1);
  const uy = (end.y - first.y) / (chord || 1);
  const lateral = Math.max(0, ...travel.map((f) => Math.abs((f.x - first.x) * -uy + (f.y - first.y) * ux)));
  const moving = travel.length >= 3 && chord >= 8;
  // the blob's look: its mass settles to a plateau (the arrow's shadow fully faded in and the disc formed) and, near the click, departs from it (press or fade-out)
  const level = /** @type {number} */ (median(tail.map((f) => f.m)));
  const off = (/** @type {Seen} */ f) => Math.abs(f.m - level) / Math.max(1, level);
  let settle = pre.length - 1;
  while (settle > 0 && off(pre[settle - 1]) <= APPEAR.settleShare) settle -= 1;
  const press = run.find((f) => f.t > pre[pre.length - 1].t && off(f) > APPEAR.pressShare);
  return {
    frames: run.length,
    censored: first.t <= -APPEAR.before + frameMs,
    appearMs: round(first.t),
    visibleBeforeMs: round(-first.t),
    disappearMs: round(last.t),
    lingerMs: round(Math.max(0, last.t)),
    start: { x: round(first.x), y: round(first.y) },
    end: { x: round(end.x), y: round(end.y) },
    startDistance: round(dist(first, dot)),
    endOffset: round(dist(end, dot)),
    travelMs: moving ? round(travelMs) : null,
    straightness: moving && length > 0 ? round(chord / length, 3) : null,
    lateralPx: moving ? round(lateral) : null,
    peakSpeed: moving ? round(peak.v) : null,
    peakFraction: moving && travelMs > 0 ? round((peak.t - first.t) / travelMs, 3) : null,
    discOnsetMs: round(pre[settle].t),
    pressMs: press ? round(press.t) : null,
    path: run.map((f) => [round(f.t), round(f.x), round(f.y), f.n, Math.round(f.m)]),
    speeds: speeds.map((s) => [round(s.t), round(s.v)]),
    usable: moving && dist(end, dot) <= APPEAR.settledPx,
    travel,
  };
}

/**
 * An episode against the planner (from the first seen position to the dot centre, after the best time shift of +-150 ms) and
 * against a generic spring on a straight path (skyFit.mjs's fit, to the settle point).
 * @param {ReturnType<typeof summarizeEpisode>} ep @param {Xy} dot @param {import('./skyFit.mjs').Planner} planner @param {[number, number]} bounds
 */
export function fitEpisode(ep, dot, planner, bounds) {
  const pts = ep.travel;
  const from = { x: pts[0].x, y: pts[0].y };
  const plan = planner(from, dot, bounds);
  const rel = pts.map((p) => ({ t: p.t - pts[0].t, x: p.x, y: p.y }));
  const errors = (/** @type {number} */ shift) =>
    rel.map((q) => {
      const p = plan.positionAt(q.t - shift);
      return Math.hypot(p.x - q.x, p.y - q.y);
    });
  let shift = 0;
  let best = /** @type {number} */ (rms(errors(0)));
  for (let s = -150; s <= 150; s += 5) {
    const r = /** @type {number} */ (rms(errors(s)));
    if (r < best - 1e-9) {
      best = r;
      shift = s;
    }
  }
  // the plan's time to come within 3 points of the dot: what the observed travel is compared with
  let settleMs = 0;
  for (let ms = 0; ms <= plan.durationMs; ms += 4) {
    const p = plan.positionAt(ms);
    if (Math.hypot(p.x - dot.x, p.y - dot.y) > 3) settleMs = ms;
  }
  const travelMs = /** @type {number} */ (ep.travelMs);
  const end = pts[pts.length - 1];
  const spring = fitMove({
    t0: pts[0].t,
    t1: end.t,
    durationMs: travelMs,
    start: pts[0],
    end,
    distance: Math.hypot(end.x - pts[0].x, end.y - pts[0].y),
    pathLength: 0,
    peakSpeed: 0,
    points: pts,
  });
  return {
    plan: {
      rmsPx: round(best, 2),
      offsetMs: shift,
      plannedMs: round(plan.durationMs),
      settleMs,
      durationRatio: round(travelMs / Math.max(1, plan.durationMs), 3),
      withinTravel: travelMs <= settleMs * 1.25 + 17,
    },
    spring: {
      response: spring.response,
      damping: spring.damping,
      rmsPx: spring.rmsPx,
      p95Px: spring.p95Px,
      progressAtStart: round(springStep(0, spring.response, spring.damping), 3),
    },
  };
}

/**
 * Every trusted click's episode in a recording.
 * @param {{ video: Video, events: import('./cursorBench.mjs').PageEvent[], toVideo: ((wall: number) => number) | null, origin: Xy | null, k: number,
 *   planner: { planner: import('./skyFit.mjs').Planner, source: string }, bounds: [number, number], labelled?: boolean }} o `origin` is the viewport's top left in source px; `labelled`: the pointer has a label chip beside it (a wider blob, centred on the tip)
 */
export function appearEpisodes({ video, events, toVideo, origin, k, planner, bounds, labelled = false }) {
  if (!toVideo || !origin) return [];
  const shows = events.filter((e) => e.type === 'show');
  const clicks = events.filter((e) => e.type === 'click' && e.trusted !== false);
  const frameMs = video.frames.length > 1 ? (video.frames[video.frames.length - 1].t - video.frames[0].t) / (video.frames.length - 1) : 17;
  const abs = (/** @type {any} */ p) => ({ x: origin.x + p.x * k, y: origin.y + p.y * k });
  const hud = /** @type {[number, number, number, number]} */ ([origin.x, origin.y, HUD_RECT[2] * k, HUD_RECT[3] * k]);
  return clicks.flatMap((c, index) => {
    // the dot this click hit: the show with the click's own index (the next dot is shown in the same millisecond), else the last one before it
    const before = shows.filter((e) => e.t < c.t);
    const dotEvent = shows.find((e) => e.i === c.i) ?? before[before.length - 1];
    if (!dotEvent) return [];
    const dot = abs(dotEvent);
    const tc = toVideo(c.t);
    const showAt = toVideo(dotEvent.t);
    // the dots shown just before and after are not cursor (unless they sit where this one does: the cursor is there)
    const at = shows.indexOf(dotEvent);
    const ignoreDiscs = [shows[at - 1], shows[at + 1]]
      .filter((e) => e && Math.hypot(e.x - dotEvent.x, e.y - dotEvent.y) > 2 * DOT_RADIUS)
      .map((e) => ({ ...abs(e), r: (DOT_RADIUS + 3) * k }));
    /** @type {Seen[]} */
    const seen = [];
    for (const f of video.frames) {
      if (f.t < tc - APPEAR.before || f.t > tc + APPEAR.after || f.t < showAt + 40) continue;
      const b = blobIn(video, f.px, { dot, k, ignoreDiscs, ignoreRects: [hud], extent: labelled ? APPEAR.labelledExtent : APPEAR.extent });
      if (b) seen.push({ t: f.t - tc, x: (b.x - origin.x) / k, y: (b.y - origin.y) / k, n: b.n, m: b.m });
    }
    let run = episodeRun(seen);
    // nothing seen before the click: a pointer that is already parked there (a persistent cursor) shows no approach to measure
    if (!run.some((f) => f.t <= 0)) return [{ index, hit: c.hit === true, found: false }];
    const dotPt = { x: dotEvent.x, y: dotEvent.y };
    // a pointer with a label chip beside it (MoPilot's) has the chip in its blob: the centre sits a fixed offset from the tip, so the path is moved by the offset it settles at (landing error is then not measured)
    if (labelled) {
      const tail = run.filter((f) => f.t <= 0).slice(-3);
      const bx = /** @type {number} */ (median(tail.map((f) => f.x))) - dotPt.x;
      const by = /** @type {number} */ (median(tail.map((f) => f.y))) - dotPt.y;
      run = run.map((f) => ({ ...f, x: f.x - bx, y: f.y - by }));
    }
    const ep = summarizeEpisode(run, dotPt, frameMs);
    const { travel, ...out } = ep;
    return [{ index, hit: c.hit === true, found: true, ...out, fit: ep.usable ? fitEpisode(ep, dotPt, planner.planner, bounds) : null }];
  });
}

const stat = (/** @type {(number | null | undefined)[]} */ xs, places = 1) => {
  const v = /** @type {number[]} */ (xs.filter((x) => typeof x === 'number' && Number.isFinite(x)));
  return { n: v.length, p50: round(median(v), places), p95: round(quantile(v, 0.95), places) };
};

/**
 * The recording's episodes as medians and p95: how many clicks yielded an episode and a usable path (and how many started before the window), the timings, the
 * start distance, the shape, the press, the linger, and the fits.
 * @param {ReturnType<typeof appearEpisodes>} list
 */
export function summarizeAppear(list) {
  const found = /** @type {any[]} */ (list.filter((e) => e.found));
  const usable = found.filter((e) => e.usable);
  const fits = usable.map((e) => e.fit);
  return {
    clicks: list.length,
    found: found.length,
    usable: usable.length,
    censored: found.filter((e) => e.censored).length,
    visibleBeforeMs: stat(found.map((e) => e.visibleBeforeMs)),
    startDistance: stat(found.map((e) => e.startDistance)),
    travelMs: stat(usable.map((e) => e.travelMs)),
    straightness: stat(
      usable.map((e) => e.straightness),
      3,
    ),
    lateralPx: stat(usable.map((e) => e.lateralPx)),
    peakFraction: stat(
      usable.map((e) => e.peakFraction),
      2,
    ),
    discOnsetMs: stat(found.map((e) => e.discOnsetMs)),
    pressMs: stat(found.map((e) => e.pressMs)),
    lingerMs: stat(found.map((e) => e.lingerMs)),
    endOffset: stat(found.map((e) => e.endOffset)),
    plan: {
      rmsPx: stat(
        fits.map((f) => f.plan.rmsPx),
        2,
      ),
      durationRatio: stat(
        fits.map((f) => f.plan.durationRatio),
        2,
      ),
      offsetMs: stat(fits.map((f) => f.plan.offsetMs)),
      withinTravel: fits.length ? round(fits.filter((f) => f.plan.withinTravel).length / fits.length, 2) : null,
    },
    spring: {
      response: stat(
        fits.map((f) => f.spring.response),
        3,
      ),
      damping: stat(
        fits.map((f) => f.spring.damping),
        2,
      ),
      rmsPx: stat(
        fits.map((f) => f.spring.rmsPx),
        2,
      ),
    },
    list,
  };
}
