// shared/cursorApproach.mjs: the default cursor plan from the observed Sky cursor (#3810): OBSERVED measurements and planApproach(); the arc/scoot planner for long moves stays in cursorMotionPlan.mjs.

import { SAMPLE_HZ, TIMING } from './cursorMotionPlan.mjs';

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const isPoint = (p) => p !== null && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y);
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);

/**
 * The observed Sky cursor (native fixture, CU path; VM recordings, #3810, single runs, 60 Hz capture). Distances in pt, times in ms.
 * defaultOffset is MoPilot's choice (not observed): where the cursor comes from with no previous point, a lower-left start about startClip away.
 */
export const OBSERVED = Object.freeze({
  startClip: 140, // appears 132-149 pt away, clipped as a whole vector; starts on the previous point when it is closer
  response: 0.25, // SwiftUI response in s (observed 0.25-0.27); omega = 2 pi / response, critically damped (damping 1.0)
  settleDistance: 0.85, // the glide ends when this close (TIMING.settleDistance); within 4 pt is reached about 20 ms sooner (observed travel 250-330 ms, visible before click 344 ms)
  hoverMs: 45, // arrival to click, observed 28-61 ms
  hideAfterClickMs: 6, // the plan's end marker for actions that do not press; a CU click's cursor stays parked after the press (phantomCursor.cjs, #3810)
  defaultOffset: Object.freeze({ x: -99, y: 99 }),
});

/**
 * The Codex desktop app's in-app browser cursor, from a VM recording (#3810, ChatGPT 26.1016.61520, 10 clicks, 60 Hz capture): it appears about 142 pt out like
 * Sky, glides on a critically damped spring with response 0.162 s (fitted, damping 1.01, travel p50 158 ms), and lingers 287 ms after the click before it
 * vanishes. hoverMs is derived (visible 343 ms before the click minus the 158 ms travel and the arrival wait), not measured directly.
 */
export const OBSERVED_CODEX_IAB = Object.freeze({ startClip: 140, response: 0.162, hoverMs: 150, hideAfterClickMs: 287 });

/** The start offset from the target: the line back to `from`, scaled to at most the start clip; the default direction when there is no usable `from`. */
function approachOffset(from, to, clip = OBSERVED.startClip) {
  const d = isPoint(from) ? sub(from, to) : { x: 0, y: 0 };
  if (len(d) < TIMING.jumpDistance) return { ...OBSERVED.defaultOffset };
  // scaled as a whole so the largest component is at most `clip`: the start stays on the line back to `from` (a per-axis clip would bend it)
  return mul(d, Math.min(1, clip / Math.max(Math.abs(d.x), Math.abs(d.y))));
}

/** How much of `offset` keeps the start inside `bounds` (1 when it already is, or without bounds). */
function fitInside(to, offset, bounds) {
  if (!bounds) return 1;
  const room = (v, lo, hi, o) => (o > 0 ? (hi - v) / o : o < 0 ? (lo - v) / o : 1);
  const kx = room(to.x, bounds.x, bounds.x + bounds.width, offset.x);
  const ky = room(to.y, bounds.y, bounds.y + bounds.height, offset.y);
  return clamp(Math.min(kx, ky), 0, 1);
}

/**
 * The default cursor plan, from the observed Sky cursor (#3810): it appears at `start`, the line back toward `from` clipped to 140 pt (largest component, direction kept) (on `from` itself when closer), glides on a straight path with a critically damped spring (response 0.25 s) until it stops (0.85 pt of
 * `to`; within 4 pt about 20 ms sooner), hovers, presses (arrow to disc) at pressAtMs and is gone hideAfterClickMs later. No fade-in, no squash or stretch (not observed).
 * `from` null or on `to` takes a deterministic lower-left start; `bounds` pulls a start that would fall outside back along the same line;
 * reducedMotion jumps: start is `to`, no glide. Samples run at 120 Hz to totalMs; `state` is arrow, disc or hidden at each sample, and `timeline` has the exact
 * state changes (the press falls between two frames).
 * @param {{ from?: {x:number,y:number}|null, to: {x:number,y:number}, bounds?: {x:number,y:number,width:number,height:number}, reducedMotion?: boolean, profile?: {startClip?:number,response?:number,hoverMs?:number,hideAfterClickMs?:number}|null }} input
 * @returns {{ start: {x:number,y:number}, to: {x:number,y:number}, durationMs: number, hoverMs: number, pressAtMs: number, hideAfterClickMs: number, totalMs: number, distance: number, samples: {t:number,x:number,y:number,progress:number,state:'arrow'|'disc'|'hidden'}[], timeline: {t:number,state:'arrow'|'disc'|'hidden'}[] }}
 */
export function planApproach(input) {
  const { from = null, to, bounds, reducedMotion = false, profile = null } = input ?? {};
  if (!isPoint(to)) throw new TypeError('planApproach: to must be a finite point');
  // a profile (OBSERVED_CODEX_IAB) overrides the Sky defaults per call; OBSERVED itself is never changed
  const P = { ...OBSERVED, ...profile };
  const base = approachOffset(from, to, P.startClip);
  const offset = reducedMotion ? { x: 0, y: 0 } : mul(base, fitInside(to, base, bounds));
  const distance = len(offset);
  const start = add(to, offset);
  const omega = (2 * Math.PI) / P.response;
  const left = (ms) => (1 + omega * (ms / 1000)) * Math.exp(-omega * (ms / 1000)); // fraction of the distance still to go
  let steps = 0;
  if (distance >= TIMING.jumpDistance) while (distance * left((steps * 1000) / SAMPLE_HZ) > OBSERVED.settleDistance) steps++; // the spring decays, so this ends
  const durationMs = (steps * 1000) / SAMPLE_HZ;
  const { hoverMs, hideAfterClickMs } = P;
  const pressAtMs = durationMs + hoverMs;
  const totalMs = pressAtMs + hideAfterClickMs;
  const samples = [];
  for (let i = 0; ; i++) {
    const t = (i * 1000) / SAMPLE_HZ;
    const progress = i >= steps ? 1 : 1 - left(t);
    const state = t >= totalMs ? 'hidden' : t >= pressAtMs ? 'disc' : 'arrow';
    samples.push({ t, x: to.x + offset.x * (1 - progress), y: to.y + offset.y * (1 - progress), progress, state });
    if (state === 'hidden') break;
  }
  const timeline = [
    { t: 0, state: 'arrow' },
    { t: pressAtMs, state: 'disc' },
    { t: totalMs, state: 'hidden' },
  ];
  return { start, to: { x: to.x, y: to.y }, durationMs, hoverMs, pressAtMs, hideAfterClickMs, totalMs, distance, samples, timeline };
}
