// Synthetic cursor recordings for the motion bench tests: a still page with a small dark square or a grey disc (the agent cursor) moving as a function of time, bench/motion/synth.swift's cursor timeline, and a fixture-page run (dots, a counter, a cursor spring-moving between them) with its page events.
import { findMoves } from '../../bench/lib/motion/cursor.mjs';
import { calibrationPosition, DOT_LUMA, HUD_RECT, planMoves } from '../../bench/lib/motion/fixture.mjs';
import { arcControls, cubicAt, springStep } from '../../bench/lib/motion/skyFit.mjs';
import assert from 'node:assert/strict';
import { drawVideo, type Video } from './motionFrames.ts';

type Fill = (x: number, y: number, w: number, h: number, v: number) => void;
export const CURSOR_LUMA = 40;
export const PAGE_LUMA = 235;

export const DISC_LUMA = 120;
export const GLYPH_LUMA = 225;

/** Sky's cursor as bench/motion/synth.swift's `disc` mode draws it: a mid-grey disc of 2 * radius px with a light pointer glyph that punches a hole in it. */
export function drawDisc(fill: Fill, cx: number, cy: number, radius = 11) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    const half = Math.round(Math.sqrt(radius * radius + radius - dy * dy));
    fill(cx - half, cy + dy, 2 * half, 1, DISC_LUMA);
  }
  fill(cx - 3, cy - 5, 5, 9, GLYPH_LUMA);
}

/** A video of a still page where a 12 px square (or, with `disc`, Sky's grey disc) sits at `at(tMs)` (null: no cursor); `extra` draws more under it. */
export function cursorVideo(
  at: (tMs: number) => [number, number] | null,
  {
    w = 320,
    h = 200,
    scale = 1,
    count = 120,
    fps = 60,
    skip = [] as number[],
    disc = false,
    radius = 11,
    extra = (_t: number, _fill: Fill) => {},
  } = {},
): Video {
  return drawVideo(
    w,
    h,
    scale,
    count,
    (t, fill) => {
      fill(0, 0, w, h, PAGE_LUMA);
      extra(t * 1000, fill);
      const p = at(t * 1000);
      if (p && disc) drawDisc(fill, Math.round(p[0]), Math.round(p[1]), radius);
      else if (p) fill(Math.round(p[0]) - 6, Math.round(p[1]) - 6, 12, 12, CURSOR_LUMA);
    },
    { fps, skip },
  );
}

/** bench/motion/synth.swift's cursor timeline: (100,120) to (520,280) from 0.5 s and back from 2.0 s, spring response 0.3 s, damping 0.9. */
export function cursorSynthVideo(scale = 2): Video {
  return cursorVideo(
    (t) => {
      const p = t < 2000 ? springStep((t - 500) / 1000, 0.3, 0.9) : 1 - springStep((t - 2000) / 1000, 0.3, 0.9);
      return [100 + 420 * p, 120 + 160 * p];
    },
    { w: 640, h: 400, scale, count: 210 },
  );
}

/** cursorSynthVideo with the disc cursor (synth.swift `disc`). */
export const discSynthVideo = (scale = 2): Video =>
  cursorVideo(
    (t) => {
      const p = t < 2000 ? springStep((t - 500) / 1000, 0.3, 0.9) : 1 - springStep((t - 2000) / 1000, 0.3, 0.9);
      return [100 + 420 * p, 120 + 160 * p];
    },
    { w: 640, h: 400, scale, count: 210, disc: true },
  );

/** A position along a straight move from `a` to `b` that starts at `start` ms on a spring. */
export const springAt = (
  a: [number, number],
  b: [number, number],
  start: number,
  t: number,
  response = 0.25,
  damping = 0.9,
): [number, number] => {
  const p = springStep((t - start) / 1000, response, damping);
  return [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p];
};

export const ORIGIN = { x: 50, y: 30 };
export const WALL0 = 1_000_000;

/**
 * A run of the fixture page's `move` plan (100 px, viewport 300x200) on a 400x300 screen with the viewport at (50, 30):
 * each dot shows 20 ms after the click on the one before, the cursor starts moving 400 ms later on a spring of response 0.25 s, and
 * the click lands 900 ms after that. With `fade` the cursor is not there between actions: it shows 400 ms before each click 70 px right and 40 px below its dot,
 * slides in on a spring (response 0.2 s) as a grey disc wider than the dot (radius 18, like Sky's soft shadow) and is gone 20 ms after the click. The page's events are in wall-clock ms (video ms + WALL0).
 */
export function fixtureRun(disc = false, fade = false) {
  const plan = planMoves(100, [300, 200]);
  const abs = plan.points.map((p) => [ORIGIN.x + p.x, ORIGIN.y + p.y] as [number, number]);
  const show: number[] = [];
  const click: number[] = [];
  const startAt: number[] = [];
  let t = 500;
  for (let i = 0; i < abs.length; i += 1) {
    show.push(t);
    startAt.push(t + 400);
    click.push(t + 1300);
    t += 1320;
  }
  const from = (i: number): [number, number] => (i ? abs[i - 1] : [40, 40]);
  const at = (ms: number): [number, number] => {
    let i = startAt.findIndex((s, k) => ms >= s && (k + 1 === startAt.length || ms < startAt[k + 1]));
    if (i < 0) i = 0;
    return springAt(from(i), abs[i], startAt[i], ms);
  };
  const atFade = (ms: number): [number, number] | null => {
    const i = click.findIndex((c) => ms >= c - 400 && ms <= c + 20);
    return i < 0 ? null : springAt([abs[i][0] + 70, abs[i][1] + 40], abs[i], click[i] - 400, ms, 0.2);
  };
  const video = cursorVideo(fade ? atFade : at, {
    w: 400,
    h: 300,
    count: Math.ceil((t / 1000) * 30),
    fps: 30,
    disc,
    radius: fade ? 18 : 11,
    extra: (ms, fill) => {
      const i = show.findLastIndex((s) => ms >= s);
      if (i < 0) return;
      // the dot, and the counter the page rewrites for each dot
      fill(Math.round(abs[i][0]) - 11, Math.round(abs[i][1]) - 11, 22, 22, DOT_LUMA);
      fill(ORIGIN.x + HUD_RECT[0] + 10, ORIGIN.y + HUD_RECT[1] + 10, 10, 10, i % 2 ? 60 : 160);
    },
  });
  const events = [
    {
      type: 'ready',
      t: WALL0,
      fixture: { plan: 'move', distance: 100 },
      viewport: [300, 200],
      // the disc run's page reports its window (a 30 px title bar), as the real page does; the other run leaves the origin to the clicks
      ...(disc ? { screenX: ORIGIN.x, screenY: ORIGIN.y - 30, outerWidth: 300, outerHeight: 230 } : {}),
    },
    ...plan.points.flatMap((p, i) => [
      { type: 'show', t: WALL0 + show[i], i, x: p.x, y: p.y },
      { type: 'click', t: WALL0 + click[i], i, hit: true, cx: p.x, cy: p.y, sx: p.x + ORIGIN.x, sy: p.y + ORIGIN.y, trusted: true },
    ]),
    { type: 'done', t: WALL0 + t },
  ];
  return { video, events, plan, abs, show, click, startAt };
}

/** The calibration moment: a target on the plan's row at `calibrationPosition`, 30 fps, `ms` long, on a 200x100 screen with the viewport at (0, 0). */
export function calibrationRun(ms = 18_000) {
  const plan = {
    kind: 'calibration' as const,
    points: [],
    y: 50,
    x0: 40,
    x1: 160,
    phases: [{ speed: 240 }, { speed: 600 }, { speed: 1200 }],
  };
  const t0 = 1000;
  const video = cursorVideo(
    (t) => {
      const p = calibrationPosition(plan, t - t0);
      return p ? [p.x, p.y] : null;
    },
    { w: 200, h: 100, count: Math.ceil((ms / 1000) * 30), fps: 30 },
  );
  return { video, plan, t0 };
}

export type Fix = { t: number; found: boolean; x: number; y: number; n: number; m: number };
export const MS = 1000 / 60;

/** A track: the cursor at `at(t)` every `step` ms for `ms`; null is a frame with no cursor. */
export const trackOf = (at: (t: number) => [number, number] | null, ms: number, step = MS): Fix[] =>
  Array.from({ length: Math.floor(ms / step) + 1 }, (_, i) => {
    const t = i * step;
    const p = at(t);
    return { t, found: !!p, x: p?.[0] ?? 0, y: p?.[1] ?? 0, n: p ? 144 : 0, m: p ? 28000 : 0 };
  });
/** A move from a to b on a spring starting at `start` ms, as a Move. */
export const moveOf = (a: [number, number], b: [number, number], opts: { response?: number; damping?: number; bulge?: number } = {}) => {
  const bulge = opts.bulge ?? 0;
  const { c1, c2 } = arcControls({ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, bulge, bulge);
  const track = trackOf((t) => {
    const s = springStep(t / 1000, opts.response ?? 0.25, opts.damping ?? 0.9);
    const p = cubicAt({ x: a[0], y: a[1] }, c1, c2, { x: b[0], y: b[1] }, s);
    return [p.x, p.y];
  }, 1400);
  const moves = findMoves(track, { settlePx: 0.2 });
  assert.equal(moves.length, 1);
  return moves[0];
};
