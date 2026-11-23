// Motion bench cursor fixture (#3810): the deterministic plans (dot positions at fixed distances and directions, repeated clicks, a typing field, a scroll page, an idle stretch, a known moving target) the fixture page and the analysis both read, and the page itself.

/** Distances between consecutive dots, in CSS px, and the eight directions in degrees: 0 is right, angles grow clockwise on screen (90 is down). */
export const DISTANCES = [30, 100, 200, 400, 800];
export const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
/** Dot radius and the free margin around every dot, in CSS px. */
export const DOT_RADIUS = 14;
export const MARGIN = 40;
/** What the click-then-type moment types, how often the repeat moment clicks, how long the idle moment records after the last action. */
export const TYPE_TEXT = 'motion bench 0123';
export const REPEAT_COUNT = 6;
export const IDLE_SECONDS = 20;
/** The calibration moment's known target: speeds in px/s, one phase each. */
export const CALIBRATION_SPEEDS = [240, 600, 1200];
export const CALIBRATION_PHASE_MS = 6000;
/** The fixture's HUD (a counter the page rewrites on every click): analysis ignores this rect, in CSS px from the viewport's top left. */
export const HUD_RECT = /** @type {[number, number, number, number]} */ ([0, 0, 240, 40]);
export const DOT_COLOR = '#00a676';
export const BACKGROUND_COLOR = '#ebebeb';

/** Rec. 601 luma of a `#rrggbb` color, as bench/motion/decode.swift computes it. */
export function lumaOf(/** @type {string} */ hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return (29 * b + 150 * g + 77 * r) >> 8;
}
export const DOT_LUMA = lumaOf(DOT_COLOR);
export const BACKGROUND_LUMA = lumaOf(BACKGROUND_COLOR);

const norm = (/** @type {number} */ deg) => ((deg % 360) + 360) % 360;
/** The unit vector of a direction in screen coordinates. */
export const direction = (/** @type {number} */ angle) =>
  /** @type {[number, number]} */ ([Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)]);

/**
 * @typedef {{ distance: number, angle: number | null }} Step the move that brings the cursor to a point: the nominal distance (px) and direction
 * @typedef {{ id: string, x: number, y: number, role: 'approach' | 'reposition' | 'out' | 'back' | 'repeat', move: Step | null }} Dot
 * @typedef {{ kind: 'move', points: Dot[], skipped: { angle: number, reason: string }[] }
 *   | { kind: 'repeat', points: Dot[] }
 *   | { kind: 'type', points: Dot[], field: { x: number, y: number, w: number, h: number }, text: string }
 *   | { kind: 'scroll', points: Dot[], pageHeight: number }
 *   | { kind: 'idle', points: Dot[] }
 *   | { kind: 'calibration', points: Dot[], y: number, x0: number, x1: number, phases: { speed: number }[] }} Plan
 */

/**
 * Dots for moves of one distance in all eight directions: four out-and-back pairs (0, 45, 90 and 135 degrees out; the way back
 * covers 180, 225, 270 and 315), each centred in the viewport. A pair that does not fit (800 px up and down on a short
 * viewport) is skipped with its reason. Moving from one pair's start to the next is a repositioning, never scored.
 * @param {number} distance @param {[number, number]} viewport @param {number} [margin]
 * @returns {Extract<Plan, { kind: 'move' }>}
 */
export function planMoves(distance, viewport, margin = MARGIN) {
  const [w, h] = viewport;
  /** @type {Dot[]} */
  const points = [];
  /** @type {{ angle: number, reason: string }[]} */
  const skipped = [];
  for (const angle of [0, 45, 90, 135]) {
    const [ux, uy] = direction(angle);
    const dx = Math.round(ux * distance);
    const dy = Math.round(uy * distance);
    if (Math.abs(dx) + 2 * margin > w || Math.abs(dy) + 2 * margin > h) {
      skipped.push({
        angle,
        reason: `${distance} px at ${angle} degrees needs ${Math.abs(dx) + 2 * margin}x${Math.abs(dy) + 2 * margin}, the viewport is ${w}x${h}`,
      });
      continue;
    }
    const sx = Math.round((w - dx) / 2);
    const sy = Math.round((h - dy) / 2);
    const add = (/** @type {number} */ x, /** @type {number} */ y, /** @type {Dot['role']} */ role, /** @type {Step | null} */ move) =>
      points.push({ id: `p${points.length}`, x, y, role, move });
    add(sx, sy, points.length ? 'reposition' : 'approach', null);
    add(sx + dx, sy + dy, 'out', { distance, angle });
    add(sx, sy, 'back', { distance, angle: norm(angle + 180) });
  }
  return { kind: 'move', points, skipped };
}

/** The point where a position of a viewport's centre is. */
const centre = (/** @type {[number, number]} */ [w, h]) => ({ x: Math.round(w / 2), y: Math.round(h / 2) });

/**
 * The plan of a fixture for one viewport. The page and the analysis both call this, so the dots the page draws are the ones the analysis expects.
 * @param {{ plan: 'move', distance: number } | { plan: 'repeat' | 'type' | 'scroll' | 'idle' | 'calibration' }} fixture @param {[number, number]} viewport
 * @returns {Plan}
 */
export function planFor(fixture, viewport) {
  const c = centre(viewport);
  if (fixture.plan === 'move') return planMoves(fixture.distance, viewport);
  if (fixture.plan === 'repeat') {
    return {
      kind: 'repeat',
      points: Array.from({ length: REPEAT_COUNT }, (_, i) => ({
        id: `p${i}`,
        ...c,
        role: i ? 'repeat' : 'approach',
        move: i ? { distance: 0, angle: null } : null,
      })),
    };
  }
  if (fixture.plan === 'type') {
    const field = { x: Math.round(c.x - 200), y: Math.round(c.y - 20), w: 400, h: 40 };
    return { kind: 'type', points: [{ id: 'p0', ...c, role: 'approach', move: null }], field, text: TYPE_TEXT };
  }
  if (fixture.plan === 'scroll') return { kind: 'scroll', points: [], pageHeight: viewport[1] * 4 };
  if (fixture.plan === 'idle') return { kind: 'idle', points: [{ id: 'p0', ...c, role: 'approach', move: null }] };
  return {
    kind: 'calibration',
    points: [],
    y: c.y,
    x0: MARGIN,
    x1: viewport[0] - MARGIN,
    phases: CALIBRATION_SPEEDS.map((speed) => ({ speed })),
  };
}

/**
 * Where the calibration target is `tMs` after its start (the page's `calib` event): it sweeps between x0 and x1 at the
 * phase's speed, back and forth, one phase after another; null once the phases are over.
 * @param {Extract<Plan, { kind: 'calibration' }>} plan @param {number} tMs
 */
export function calibrationPosition(plan, tMs) {
  const phase = Math.floor(tMs / CALIBRATION_PHASE_MS);
  if (tMs < 0 || phase >= plan.phases.length) return null;
  const { speed } = plan.phases[phase];
  const length = plan.x1 - plan.x0;
  const travelled = ((speed * (tMs - phase * CALIBRATION_PHASE_MS)) / 1000) % (2 * length);
  return { x: plan.x0 + (travelled <= length ? travelled : 2 * length - travelled), y: plan.y, speed, phase };
}

/** The moves a plan expects, in order: from the previous dot to this one, with the nominal distance and direction. */
export function expectedMoves(/** @type {Plan} */ plan) {
  return plan.points.flatMap((to, i) => (to.move && i ? [{ index: i, from: plan.points[i - 1], to, ...to.move }] : []));
}

/**
 * This module's source as a classic script: the `export` keywords are stripped (also `export { ... }` lists) and the names the
 * page uses are published on `window.__fixture`. Everything else is kept byte for byte.
 * @param {string} src
 */
export function classicFixtureSource(src) {
  return `${src.replace(/^export \{[^}]*\};?[ \t]*$/gm, '').replace(/^export /gm, '')}\nwindow.__fixture = { planFor, calibrationPosition, TYPE_TEXT };\n`;
}

/**
 * The fixture page: one dot at a time at the plan's positions, a typing field, a tall page, or a known moving target.
 * It logs what it saw (dots shown, clicks with client and screen coordinates, keys, scrolls) to the fixture server
 * with wall-clock times: the ground truth the analysis joins with the recording. It loads this file's classic-script form
 * from `/fixture.js` (see `classicFixtureSource`; the native fixture app's WKWebView does not run ES modules), so the page
 * computes the same plan as the analysis for its own viewport.
 */
export function fixtureHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Motion fixture</title>
<style>
html,body{margin:0;height:100%}body{background:${BACKGROUND_COLOR};font:15px -apple-system,sans-serif;color:#222;overflow-x:hidden}
#hud{position:fixed;left:8px;top:8px;width:${HUD_RECT[2] - 16}px;height:${HUD_RECT[3] - 16}px;line-height:24px}
.dot{position:absolute;width:${2 * DOT_RADIUS}px;height:${2 * DOT_RADIUS}px;border-radius:50%;background:${DOT_COLOR};transform:translate(-50%,-50%);cursor:pointer}
#field{position:absolute;font:20px -apple-system,sans-serif;padding:0 10px;box-sizing:border-box;border:2px solid #444;background:#fff}
#tall{position:absolute;left:0;top:0;width:1px}.row{position:absolute;left:20px;font-size:18px;color:#555}
#end{position:absolute;left:20px;padding:12px 24px;background:#222;color:#fff;font-size:28px}
</style></head><body>
<div id="hud"></div>
<script src="/fixture.js"></script>
<script>
(() => {
const { planFor, calibrationPosition, TYPE_TEXT } = window.__fixture;
const fixture = JSON.parse(new URLSearchParams(location.search).get('fixture') || '{"plan":"idle"}');
const viewport = [innerWidth, innerHeight];
const plan = planFor(fixture, viewport);
const hud = document.getElementById('hud');
const log = (type, data = {}) => {
  const e = { type, t: Date.now(), ...data };
  (window.__events ||= []).push(e);
  navigator.sendBeacon('/event', JSON.stringify(e));
};
const status = (text) => { hud.textContent = text; };
log('ready', { fixture, viewport, dpr: devicePixelRatio, screenX, screenY, outerWidth, outerHeight, frame: window.__motionFrame ?? null, points: plan.points });
let at = 0;
let dot = null;
const finish = () => { dot?.remove(); dot = null; status('Done'); log('done'); };
function show() {
  dot?.remove();
  if (at >= plan.points.length) return finish();
  const p = plan.points[at];
  dot = Object.assign(document.createElement('div'), { className: 'dot' });
  dot.style.left = p.x + 'px';
  dot.style.top = p.y + 'px';
  document.body.append(dot);
  status('Dot ' + (at + 1) + ' of ' + plan.points.length);
  log('show', { i: at, x: p.x, y: p.y });
}
addEventListener('pointerdown', (e) => {
  const p = plan.points[at];
  const hit = !!p && !!dot && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= ${DOT_RADIUS};
  log('click', { i: at, hit, cx: e.clientX, cy: e.clientY, sx: e.screenX, sy: e.screenY, trusted: e.isTrusted });
  if (hit) { at += 1; show(); }
}, true);
if (plan.kind === 'type') {
  const f = Object.assign(document.createElement('input'), { id: 'field', type: 'text' });
  Object.assign(f.style, { left: plan.field.x + 'px', top: plan.field.y + 'px', width: plan.field.w + 'px', height: plan.field.h + 'px' });
  document.body.append(f);
  status('Click the field and type the text');
  f.addEventListener('input', () => log('key', { value: f.value }));
  f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { log('submit', { value: f.value, ok: f.value === TYPE_TEXT }); if (f.value === TYPE_TEXT) finish(); } });
} else if (plan.kind === 'scroll') {
  const tall = document.getElementById('hud').parentNode.appendChild(Object.assign(document.createElement('div'), { id: 'tall' }));
  tall.style.height = plan.pageHeight + 'px';
  for (let y = 80; y < plan.pageHeight - 200; y += 60) tall.append(Object.assign(document.createElement('div'), { className: 'row', textContent: 'Row ' + y, style: 'top:' + y + 'px' }));
  tall.append(Object.assign(document.createElement('div'), { id: 'end', textContent: 'END', style: 'top:' + (plan.pageHeight - 160) + 'px' }));
  status('Scroll down to END, then back up');
  let bottom = false;
  addEventListener('scroll', () => {
    log('scroll', { y: scrollY });
    if (scrollY + innerHeight >= plan.pageHeight - 4) bottom = true;
    if (bottom && scrollY <= 0) finish();
  });
} else if (plan.kind === 'calibration') {
  const t0 = Date.now() + 1000;
  log('calib', { t0 });
  const target = Object.assign(document.createElement('div'), { className: 'dot' });
  document.body.append(target);
  const tick = () => {
    const pos = calibrationPosition(plan, Date.now() - t0);
    target.style.display = pos ? 'block' : 'none';
    if (pos) { target.style.left = pos.x + 'px'; target.style.top = pos.y + 'px'; requestAnimationFrame(tick); } else if (Date.now() > t0) finish(); else requestAnimationFrame(tick);
  };
  tick();
} else show();
})();
</script></body></html>
`;
}
