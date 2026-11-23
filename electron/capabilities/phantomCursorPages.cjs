// The phantom cursor's pages: static HTML with CSS animations (no script, nothing to click) for an approach (planApproach's glide), a drag's path (Sky shows no click ring).

/**
 * A drag goes through every point of its path; a timing function applies to each stretch between two points, so a
 * spring would surge at every one: a drag keeps an even ease over a longer glide, its path drawn alongside.
 */
const DRAG_MS = 380;

/** The arrow (its tip at 2,2 of 22) and the press fog; our own artwork, grey as Sky's (ChatGPT 26.1103: a grey arrow that shrinks a little at the press, with a soft grey glow that comes up under it; both stay until the next action). */
const ARROW =
  '<path d="M2 2 L2 18 L6.5 13.8 L9.6 20.4 L12.6 19 L9.6 12.6 L15.6 12.6 Z" fill="#4a4a50" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>';

const num = (n) => Math.round(Number(n) * 10) / 10;
const PAGE = (css, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;user-select:none}${css}</style></head><body>${body}</body></html>`;

/**
 * The page for one approach, from a planApproach() plan in window points: the cursor starts at plan.start and glides to plan.to on the
 * plan's progress curve (a CSS linear() of its 120 Hz samples; transform and opacity only, so it runs on the compositor), shows an arrow,
 * and at plan.pressAtMs swaps it for a disc (`press`); everything is gone at plan.totalMs, or, for a press with `holdMs`, holdMs after the press (the disc waits for the action's report). With no glide (reduced motion) it sits on the target.
 * The animations are paused: the page shows the start until the main process inserts RUN_CSS, so the animation clock starts when it says.
 */
function approachHtml({ plan, press, nonce = '', holdMs = 0 }) {
  const { start, to, durationMs: glide, pressAtMs } = plan;
  // a click's disc is held holdMs past the press (the report ends it sooner); other actions play to the plan's end
  const totalMs = press && holdMs > 0 ? pressAtMs + holdMs : plan.totalMs;
  const at = (p) => `translate(${num(p.x - 2)}px,${num(p.y - 2)}px)`;
  const curve = plan.samples
    .filter((s) => s.t <= glide)
    .map((s) => Math.round(s.progress * 10000) / 10000)
    .join(',');
  // a page that lives PARK_MS past the press: one 0.1 % step would be ~120 ms, so the press keyframe keeps five decimals
  const pressAt = Math.round((pressAtMs / totalMs) * 1e7) / 1e5;
  const life = `life ${totalMs}ms step-end both`;
  const moving = glide > 0 ? `glide ${glide}ms linear(${curve}) both,` : '';
  return PAGE(
    // `nonce` makes every approach its own document (its URL is unique), so a start signal can be checked against the page it is meant for
    `/* ${nonce} */.cur{position:absolute;left:0;top:0;width:22px;height:22px;transform:${at(to)};animation:${moving}${life};filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
${glide > 0 ? `@keyframes glide{from{transform:${at(start)}}to{transform:${at(to)}}}\n` : ''}@keyframes life{0%{opacity:1}100%{opacity:0}}
.arrow,.disc{position:absolute;left:0;top:0}
${
  press
    ? `.arrow{transform-origin:2px 2px;animation:arrow ${totalMs}ms step-end both}
.disc{left:-11px;top:-10px;width:40px;height:40px;border-radius:50%;background:radial-gradient(circle,rgba(70,70,75,.42) 0,rgba(70,70,75,.27) 40%,rgba(70,70,75,0) 72%);opacity:0;animation:disc ${totalMs}ms step-end both}
@keyframes arrow{0%{transform:scale(1)}${pressAt}%{transform:scale(.8)}100%{transform:scale(.8)}}
@keyframes disc{0%{opacity:0}${pressAt}%{opacity:1}100%{opacity:1}}
`
    : ''
}@media (prefers-reduced-motion:reduce){.cur{animation:${life}}}
.cur,.arrow,.disc{animation-play-state:paused}`,
    `<div class="cur" aria-hidden="true">${press ? '<div class="disc"></div>' : ''}<svg class="arrow" width="22" height="22" viewBox="0 0 22 22">${ARROW}</svg></div>`,
  );
}

/**
 * The older page for a drag in a window of `width`×`height` points: the pointer glides evenly from `from` through `points`
 * (window points) and the path is drawn as long as it is. A timing function applies to each stretch between two points, so a spring
 * would surge at every one.
 */
function cursorHtml({ width, height, from, points }) {
  const to = points[points.length - 1];
  const stops = [from, ...points];
  const frames = stops.map((p, i) => `${num((i / (stops.length - 1)) * 100)}%{transform:translate(${num(p.x)}px,${num(p.y)}px)}`).join('');
  const len = points.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
  return PAGE(
    `.cur{position:absolute;left:0;top:0;width:22px;height:22px;transform:translate(${num(to.x)}px,${num(to.y)}px);animation:glide ${DRAG_MS}ms cubic-bezier(.2,.8,.2,1) both;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
@keyframes glide{${frames}}
.path{position:absolute;left:0;top:0}
.path polyline{fill:none;stroke:rgba(92,143,255,.85);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:${num(len)};stroke-dashoffset:${num(len)};animation:draw ${DRAG_MS}ms ease-in-out both}
@keyframes draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.cur,.path polyline{animation-duration:1ms;animation-delay:0ms}}`,
    `<svg class="path" width="${num(width)}" height="${num(height)}"><polyline points="${points.map((p) => `${num(p.x)},${num(p.y)}`).join(' ')}"/></svg><svg class="cur" viewBox="0 0 22 22" aria-hidden="true">${ARROW}</svg>`,
  );
}

module.exports = { cursorHtml, approachHtml, num, DRAG_MS };
