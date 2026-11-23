// Motion bench agent-cursor analysis (#3810): cursor detection per frame against the page's still background, moves cut from the track, their path (chord frame, deviation, overshoot), update rate and jitter, matching to the fixture's expected moves, and the idle fade.
import { cells } from './frames.mjs';
import { median, round, spread } from './stats.mjs';

/** @typedef {import('./frames.mjs').Video} Video */
/** @typedef {import('./frames.mjs').Rect} Rect */
/** @typedef {{ t: number, found: boolean, x: number, y: number, n: number, m: number }} Fix one frame's cursor: centre in source px, size (source px²) and mass (luma change summed over its pixels) */
/** @typedef {{ t0: number, t1: number, x: number, y: number, r: number, luma: number, tol: number }} Disc pixels of this luma inside the disc are not cursor in [t0, t1] ms (a fixture dot) */
/** @typedef {{ rects: Rect[], discs: Disc[] }} Ignore */
/** @typedef {{ t: number, x: number, y: number }} Pt */

/** A pixel is cursor when it differs from the page background by more than this many luma levels (a shadow or glow edge counts, compression noise does not). */
export const CURSOR_DELTA = 24;

/** A disc cursor (Sky's grey disc with a pointer glyph in it): across in source px, share of its bounding box that changed (a disc is about 0.79, the glyph punches holes in it), and how round its box is. */
export const DISC = { minSize: 14, maxSize: 40, minFill: 0.5, maxFill: 0.95, maxAspect: 1.35, darkShare: 0.6 };

/** The 8-connected groups of changed cells. */
function components(/** @type {{ x: number, y: number, d: number, dark: boolean }[]} */ hits) {
  const key = (/** @type {number} */ x, /** @type {number} */ y) => y * 65536 + x;
  const at = new Map(hits.map((h) => [key(h.x, h.y), h]));
  const seen = new Set();
  /** @type {typeof hits[]} */
  const groups = [];
  for (const h of hits) {
    if (seen.has(key(h.x, h.y))) continue;
    seen.add(key(h.x, h.y));
    const group = [];
    const stack = [h];
    while (stack.length) {
      const c = /** @type {typeof h} */ (stack.pop());
      group.push(c);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const next = at.get(key(c.x + dx, c.y + dy));
          if (next && !seen.has(key(next.x, next.y))) {
            seen.add(key(next.x, next.y));
            stack.push(next);
          }
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * The disc-shaped group among the changed cells, if any: a compact, roughly round blob of `DISC` size that is mostly
 * darker than the background. The heaviest one when several qualify. Its centre is the middle of its bounding box (the
 * glyph inside does not pull it). Null when no group is a disc, so the arrow path runs.
 */
function discBlob(/** @type {{ x: number, y: number, d: number, dark: boolean }[]} */ hits, /** @type {number} */ s) {
  /** @type {{ x: number, y: number, n: number, m: number } | null} */
  let best = null;
  for (const group of components(hits)) {
    const xs = group.map((h) => h.x);
    const ys = group.map((h) => h.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0 + 1;
    const h = Math.max(...ys) - y0 + 1;
    const fill = group.length / (w * h);
    const aspect = Math.max(w, h) / Math.min(w, h);
    const dark = group.filter((g) => g.dark).length / group.length;
    const mass = group.reduce((a, g) => a + g.d, 0) * s * s;
    const size = ((w + h) / 2) * s;
    const round = size >= DISC.minSize && size <= DISC.maxSize && fill >= DISC.minFill && fill <= DISC.maxFill && aspect <= DISC.maxAspect;
    if (round && dark >= DISC.darkShare && (!best || mass > best.m)) {
      best = { x: (x0 + w / 2) * s, y: (y0 + h / 2) * s, n: group.length * s * s, m: mass };
    }
  }
  return best;
}

/** The per-cell median of up to `samples` evenly spaced frames over a region: the page without the cursor, which is in any one place for under half the time. */
export function medianBackground(/** @type {Video} */ video, /** @type {Rect} */ rect, samples = 31) {
  const { x0, y0, x1, y1 } = cells(video, rect);
  const n = video.frames.length;
  const picks = Array.from({ length: Math.min(samples, n) }, (_, k) => video.frames[Math.floor(((k + 0.5) * n) / Math.min(samples, n))].px);
  const out = new Uint8Array((x1 - x0) * (y1 - y0));
  const column = new Array(picks.length);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      for (let k = 0; k < picks.length; k += 1) column[k] = picks[k][y * video.width + x];
      out[(y - y0) * (x1 - x0) + (x - x0)] = /** @type {number} */ (median(column));
    }
  }
  return out;
}

/** A background of one luma over a region, for a page whose background is known (the fixture's): a cursor that rests is then still found, which the median of the frames would call background. */
export function flatBackground(/** @type {Video} */ video, /** @type {Rect} */ rect, /** @type {number} */ luma) {
  const { x0, y0, x1, y1 } = cells(video, rect);
  return new Uint8Array((x1 - x0) * (y1 - y0)).fill(luma);
}

/**
 * The cursor in every frame: the pixels that differ from the background by CURSOR_DELTA (minus the ignored rects and
 * dots), their weighted centre pulled in twice to the pixels within `reach` source px of it (a glow, a pill or a
 * ripple far from the arrow does not drag it). A frame with under `minCells` such cells has no cursor; one where more
 * than `maxShare` of the region changed (a window switch) has none either.
 * @param {Video} video
 * @param {{ rect: Rect, delta?: number, minCells?: number, maxShare?: number, reach?: number, ignore?: Partial<Ignore>, background?: Uint8Array }} o
 * @returns {Fix[]}
 */
export function detectCursor(video, { rect, delta = CURSOR_DELTA, minCells = 2, maxShare = 0.3, reach = 48, ignore = {}, background }) {
  const { x0, y0, x1, y1 } = cells(video, rect);
  const w = x1 - x0;
  const bg = background ?? medianBackground(video, rect);
  const s = video.scale;
  const skip = (ignore.rects ?? []).map((r) => {
    try {
      return cells(video, r);
    } catch {
      // a rect wholly outside the region ignores nothing
      return null;
    }
  });
  const rects = skip.filter((c) => c !== null);
  const discs = ignore.discs ?? [];
  const maxCells = maxShare * w * (y1 - y0);
  return video.frames.map((frame) => {
    /** @type {{ x: number, y: number, d: number, dark: boolean }[]} */
    let hits = [];
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const v = frame.px[y * video.width + x];
        const d = Math.abs(v - bg[(y - y0) * w + (x - x0)]);
        if (d <= delta) continue;
        if (rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) continue;
        const px = (x + 0.5) * s;
        const py = (y + 0.5) * s;
        if (discs.some((c) => frame.t >= c.t0 && frame.t <= c.t1 && Math.hypot(px - c.x, py - c.y) <= c.r && Math.abs(v - c.luma) <= c.tol))
          continue;
        hits.push({ x, y, d, dark: v < bg[(y - y0) * w + (x - x0)] });
      }
    }
    if (hits.length < minCells || hits.length > maxCells) return { t: frame.t, found: false, x: 0, y: 0, n: 0, m: 0 };
    // a disc cursor is found as a blob first: its glyph and soft edge would otherwise drag the weighted centre
    const disc = discBlob(hits, s);
    if (disc) return { t: frame.t, found: true, ...disc };
    const centre = (/** @type {typeof hits} */ list) => {
      const mass = list.reduce((a, h) => a + h.d, 0);
      return { x: list.reduce((a, h) => a + h.x * h.d, 0) / mass, y: list.reduce((a, h) => a + h.y * h.d, 0) / mass };
    };
    let c = centre(hits);
    for (let pass = 0; pass < 2; pass += 1) {
      const near = hits.filter((h) => Math.hypot(h.x - c.x, h.y - c.y) * s <= reach);
      // everything farther than `reach` from the centre: keep the whole set rather than lose the cursor
      if (!near.length) break;
      hits = near;
      c = centre(hits);
    }
    const mass = hits.reduce((a, h) => a + h.d, 0) * s * s;
    return { t: frame.t, found: true, x: (c.x + 0.5) * s, y: (c.y + 0.5) * s, n: hits.length * s * s, m: mass };
  });
}

/**
 * @typedef {{ t0: number, t1: number, durationMs: number, start: Pt, end: Pt, distance: number, pathLength: number, peakSpeed: number, points: Pt[] }} Move
 * One move of the cursor: from where it left its start to where it settled.
 */

/**
 * Moves cut from a track: a move starts when the cursor goes faster than `startSpeed` (px/s) and ends when it falls
 * under `stopSpeed` or the track loses it for over `maxGapMs`; the ends are then trimmed to where the cursor was
 * within `settlePx` of its start and its end (an eased tail creeps for many frames), and a move shorter than
 * `minTravel` px is noise.
 * Speed is taken over the last `windowMs`, so a cursor redrawn on every other frame is one move, not a series.
 * @param {Fix[]} track @param {{ startSpeed?: number, stopSpeed?: number, settlePx?: number, minTravel?: number, maxGapMs?: number, windowMs?: number }} [o]
 * @returns {Move[]}
 */
export function findMoves(track, { startSpeed = 80, stopSpeed = 25, settlePx = 1.5, minTravel = 6, maxGapMs = 80, windowMs = 50 } = {}) {
  const fixes = track.filter((f) => f.found);
  /** @type {Move[]} */
  const moves = [];
  /** @type {number[]} */
  let run = [];
  const close = () => {
    // a run always has the two fixes that started it
    const move = run.length ? finishMove(fixes, run, settlePx, minTravel) : null;
    if (move) moves.push(move);
    run = [];
  };
  for (let i = 1; i < fixes.length; i += 1) {
    const dt = fixes[i].t - fixes[i - 1].t;
    // speed over the last windowMs: a cursor redrawn at half the recorder's rate stands still every other frame
    let j = i - 1;
    while (j > 0 && fixes[i].t - fixes[j].t < windowMs && fixes[j].t - fixes[j - 1].t <= maxGapMs) j -= 1;
    const v = (Math.hypot(fixes[i].x - fixes[j].x, fixes[i].y - fixes[j].y) / (fixes[i].t - fixes[j].t)) * 1000;
    if (dt > maxGapMs) close();
    if (!run.length) {
      if (v >= startSpeed && dt <= maxGapMs) run = Array.from({ length: i - j + 1 }, (_, k) => j + k);
    } else if (dt <= maxGapMs && v >= stopSpeed) run.push(i);
    else close();
  }
  close();
  return moves;
}

/** A run of fix indexes as a move: trimmed to its settle points, or null when it travelled under `minTravel`. */
function finishMove(
  /** @type {Fix[]} */ fixes,
  /** @type {number[]} */ run,
  /** @type {number} */ settlePx,
  /** @type {number} */ minTravel,
) {
  const first = fixes[run[0]];
  const last = fixes[run[run.length - 1]];
  let a = 0;
  while (a < run.length - 1 && Math.hypot(fixes[run[a + 1]].x - first.x, fixes[run[a + 1]].y - first.y) <= settlePx) a += 1;
  let b = run.length - 1;
  while (b > a && Math.hypot(fixes[run[b - 1]].x - last.x, fixes[run[b - 1]].y - last.y) <= settlePx) b -= 1;
  const points = run.slice(a, b + 1).map((i) => ({ t: fixes[i].t, x: fixes[i].x, y: fixes[i].y }));
  const start = points[0];
  const end = points[points.length - 1];
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < minTravel) return null;
  let pathLength = 0;
  let peakSpeed = 0;
  for (let k = 1; k < points.length; k += 1) {
    const step = Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
    pathLength += step;
    peakSpeed = Math.max(peakSpeed, (step / (points[k].t - points[k - 1].t)) * 1000);
  }
  return { t0: start.t, t1: end.t, durationMs: end.t - start.t, start, end, distance, pathLength, peakSpeed, points };
}

/**
 * A move's points in its chord frame: `u` along the straight line from start to end, `v` across it (positive to the
 * right of the direction of travel, y down), `t` ms from the start; px.
 * @param {Pt[]} points
 */
export function chordFrame(points) {
  const a = points[0];
  const b = points[points.length - 1];
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  return points.map((p) => ({ t: p.t - a.t, u: (p.x - a.x) * ux + (p.y - a.y) * uy, v: (p.x - a.x) * -uy + (p.y - a.y) * ux }));
}

/** The shape of a move: path length over distance, the largest sideways deviation and its side, the overshoot past the end, when the speed peaked. */
export function pathShape(/** @type {Move} */ move) {
  const frame = chordFrame(move.points);
  const bulge = frame.reduce((best, p) => (Math.abs(p.v) > Math.abs(best) ? p.v : best), 0);
  const overshoot = Math.max(0, ...frame.map((p) => p.u - move.distance));
  let peakAt = 0;
  let peak = -1;
  for (let k = 1; k < move.points.length; k += 1) {
    const speed =
      Math.hypot(move.points[k].x - move.points[k - 1].x, move.points[k].y - move.points[k - 1].y) /
      (move.points[k].t - move.points[k - 1].t);
    if (speed > peak) {
      peak = speed;
      peakAt = (move.points[k].t - move.t0) / move.durationMs;
    }
  }
  return {
    straightness: round(move.pathLength / move.distance, 3),
    deviationPx: round(Math.abs(bulge)),
    deviationShare: round(Math.abs(bulge) / move.distance, 3),
    side: Math.abs(bulge) < 0.05 ? 'none' : bulge > 0 ? 'right' : 'left',
    overshootPx: round(overshoot),
    peakAtShare: round(peakAt, 3),
  };
}

/**
 * How often the cursor is redrawn while it moves: the intervals between frames where it changed place by at least
 * `eps` px (the cursor's own update rate), and between all captured frames inside moves (the recorder's). The
 * recorder's rate caps what the cursor's can show: `captureLimited` says so when both are within 10%.
 * @param {Move[]} moves @param {number} [eps]
 */
export function updateRate(moves, eps = 0.25) {
  /** @type {number[]} */
  const updates = [];
  /** @type {number[]} */
  const capture = [];
  for (const move of moves) {
    let last = move.points[0];
    for (let k = 1; k < move.points.length; k += 1) {
      capture.push(move.points[k].t - move.points[k - 1].t);
      if (Math.hypot(move.points[k].x - last.x, move.points[k].y - last.y) >= eps) {
        updates.push(move.points[k].t - last.t);
        last = move.points[k];
      }
    }
  }
  const u = spread(updates);
  const c = spread(capture);
  const fps = (/** @type {number | null} */ p50) => (p50 ? round(1000 / p50) : null);
  return {
    updates: u,
    capture: c,
    fps: fps(u.p50),
    captureFps: fps(c.p50),
    captureLimited: u.p50 !== null && c.p50 !== null && u.p50 <= c.p50 * 1.1,
  };
}

/**
 * Expected moves (from the fixture plan, in source px) matched in order to found moves: a move matches when it starts
 * within `tolerance` px of the expected start and ends within it of the expected end. An expected move with no match
 * gets null. Each found move is used once, and later expectations take only later moves.
 * @template {{ from: { x: number, y: number }, to: { x: number, y: number } }} E
 * @param {Move[]} moves @param {E[]} expected @param {number} [tolerance]
 */
export function matchMoves(moves, expected, tolerance = 24) {
  let next = 0;
  return expected.map((e) => {
    for (let k = next; k < moves.length; k += 1) {
      const m = moves[k];
      if (
        Math.hypot(m.end.x - e.to.x, m.end.y - e.to.y) <= tolerance &&
        Math.hypot(m.start.x - e.from.x, m.start.y - e.from.y) <= tolerance
      ) {
        next = k + 1;
        return { expected: e, move: m };
      }
    }
    return { expected: e, move: null };
  });
}

/**
 * The idle fade after the last action at `afterMs`: how long the cursor kept its full weight, then how long it took to
 * fade out, from the track's mass (the cursor's pixels' luma change). The full weight is the median mass of the 500 ms
 * before `afterMs`. The fade starts when the mass drops under 90% of it, and ends under 5%. Nulls when the
 * cursor never faded in the recording, or had no weight before.
 * @param {Fix[]} track @param {number} afterMs
 */
export function idleFade(track, afterMs) {
  const before = track.filter((f) => f.found && f.t <= afterMs && f.t >= afterMs - 500).map((f) => f.m);
  const full = median(before);
  if (!full) return { fullMass: null, delayMs: null, fadeMs: null, goneMs: null };
  const after = track.filter((f) => f.t > afterMs);
  const weight = (/** @type {Fix} */ f) => (f.found ? f.m : 0);
  const started = after.find((f) => weight(f) < 0.9 * full);
  if (!started) return { fullMass: round(full), delayMs: null, fadeMs: null, goneMs: null };
  const gone = after.find((f) => f.t >= started.t && weight(f) < 0.05 * full);
  return {
    fullMass: round(full),
    delayMs: round(started.t - afterMs),
    fadeMs: gone ? round(gone.t - started.t) : null,
    goneMs: gone ? round(gone.t - afterMs) : null,
  };
}
