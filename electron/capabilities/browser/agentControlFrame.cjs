// The in-page "an agent controls this tab" frame for the user's Chrome (#1632): a glow around the viewport and a pill with Stop, drawn inside the agent cursor's overlay.
//
// In the in-app browser the pane's own toolbar says an agent drives the tab and offers Take over; a tab in the user's
// Chrome has no such chrome around it, so the page shows it, as Claude in Chrome's agent indicator does:
// - a soft glow around the viewport while the chat's agent holds the tab, and a pill at the bottom ("MoPilot is
//   working in this tab", Stop). Stop is MoPilot's Esc: it stops the chat's turn, which lets go of the tab (and
//   removes the frame). If the frame is still there STOP_CHECK_MS later, the pill says so and Stop can be pressed again,
//   as Claude in Chrome's "Stop didn't reach Claude" does.
// - While the chat waits for the user's OK (an approval card, in the app and the side panel) the pill says so in yellow and offers
//   Review, which opens the chat in MoPilot: the side panel can't be opened from the page (Chrome opens it only on a click in
//   the extension's own UI).
// - On the chat's other tabs the agent holds this turn (its tab group's), as Claude in Chrome's "Claude is active in this tab group":
//   no glow, "MoPilot is active in this tab group" and Go to tab, which brings the tab the agent works on to the front.
// - It lives in the cursor overlay (agentCursor.cjs): the same isolated world, closed shadow root and aria-hidden host,
//   so the agent's page reads never see it, and it hides with the pointer for screenshots.
// - Stop answers only a real click (event.isTrusted) and reaches main through a CDP binding (Runtime.addBinding) that
//   exists only in the cursor's world: the page's own scripts can neither see nor call it.
// - The agent's own input never reaches Stop: an action near the pill moves it to the other edge first, the button is
//   out of the Tab order, and the pill takes no pointer (so the page agent's hit tests see the page under it) until
//   the mouse is over it.
// - Motion: #1511's tokens (src/styles/tokens.css) inlined, since the page can't read the app's CSS: --dur-base with
//   --ease-enter for the entrance and --ease-exit for the exit (leave: the whole overlay fades before it goes), and a slow breathing glow on opacity only, on its own layer, which
//   the compositor runs without restyling the page (a box-shadow breath restyles it 60 times a second). Under prefers-reduced-motion nothing moves or breathes: the frame and the pill
//   only fade in and out.

/* eslint-disable no-restricted-globals */
/**
 * Runs in the cursor world (serialized with toString: it must not close over anything). Builds the frame inside
 * `layer` and returns what the overlay needs from it.
 * @param {{ layer: HTMLElement, stop: (payload: string) => boolean, checkMs?: number }} o stop: calls main's binding ('stop', 'review' or 'front'); false
 *   when it is missing; checkMs: how long Stop may take before the pill says it didn't reach MoPilot
 */
function controlFrame({ layer, stop, checkMs = 1500 }) {
  const doc = layer.ownerDocument;
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const glow = el('div', 'mp-frame');
  glow.append(el('div', 'mp-glow'));
  const pill = el('div', 'mp-pill');
  const dot = el('span', 'mp-dot');
  const WORKING = 'MoPilot is working in this tab';
  const text = el('span', 'mp-text', WORKING);
  text.hidden = true;
  const review = el('button', 'mp-review', 'Review');
  review.type = 'button';
  review.tabIndex = -1;
  review.title = 'Open this chat in MoPilot';
  review.hidden = true;
  const go = el('button', 'mp-go', 'Go to tab');
  go.type = 'button';
  go.tabIndex = -1;
  go.title = 'Show the tab MoPilot is working in';
  go.hidden = true;
  /** the chat's turn waits for the user's OK; this tab is another of the group's, not the one the agent works on */
  let waiting = false;
  let group = false;
  const button = el('button', 'mp-stop', 'Stop MoPilot');
  /** a Stop that didn't arrive: its notice stays over the turn's words until Stop is pressed again */
  let missed = false;
  button.type = 'button';
  // the agent's Tab presses must not reach it
  button.tabIndex = -1;
  button.title = 'Stop the agent (Esc in MoPilot)';
  pill.append(dot, text, review, go, button);
  layer.prepend(glow);
  layer.append(pill);
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // only the user's own click: a page script can't reach this button, and must not be able to stop the chat either
    if (!e.isTrusted || button.disabled) return;
    if (!stop('stop')) return;
    missed = false;
    button.disabled = true;
    text.hidden = false;
    text.textContent = 'Stopping…';
    setTimeout(() => {
      // a stopped turn removed the overlay; still here, the stop didn't arrive
      if (!pill.isConnected) return;
      text.textContent = "Stop didn't reach MoPilot. Press Esc there.";
      missed = true;
      button.disabled = false;
    }, checkMs);
  });
  go.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.isTrusted) stop('front');
  });
  review.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.isTrusted) stop('review');
  });
  // the pill takes the pointer only while the mouse is over it: until then hit tests see the page under it
  const near = (e) => {
    if (!pill.isConnected) return void window.removeEventListener('mousemove', near, true);
    const r = pill.getBoundingClientRect();
    const over = e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
    pill.classList.toggle('mp-live', over);
  };
  window.addEventListener('mousemove', near, true);
  /** The pill's words for the turn and the tab; a Stop on its way, or one that didn't arrive, keeps its own. */
  const say = () => {
    text.hidden = !waiting && !group && !button.disabled && !missed;
    if (!button.disabled && !missed)
      text.textContent = waiting ? 'Waiting for your OK' : group ? 'MoPilot is active in this tab group' : WORKING;
  };
  const reduced = () => !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    /** Fades the overlay `host` out and removes it (the overlay's clear). */
    leave(/** @type {HTMLElement} */ host) {
      window.removeEventListener('mousemove', near, true);
      pill.classList.remove('mp-live');
      const ms = reduced() ? 120 : 200;
      host.style.transition = `opacity ${ms}ms cubic-bezier(0.8, 0, 0.4, 1)`;
      host.style.opacity = '0';
      setTimeout(() => host.remove(), ms);
    },
    /** The chat's turn: 'waiting' for the user's OK, else working. */
    status(/** @type {string} */ s) {
      waiting = s === 'waiting';
      pill.classList.toggle('mp-waiting', waiting);
      review.hidden = !waiting;
      say();
    },
    /** 'group' on another of the chat's tabs (no glow, Go to tab), else 'front': the tab the agent works on. */
    role(/** @type {string} */ r) {
      group = r === 'group';
      glow.hidden = group;
      go.hidden = !group;
      say();
    },
    /** Moves the pill away from a point the agent is about to act on (viewport coordinates). */
    avoid(/** @type {number | null} */ y) {
      if (y == null || !Number.isFinite(y)) return;
      const h = window.innerHeight || 0;
      pill.classList.toggle('mp-top', y > h - 96);
    },
  };
}
/* eslint-enable no-restricted-globals */

/** The frame's warm three-layer glow and compact Stop pill, added only to the overlay's shadow root. */
const FRAME_CSS = `
  .mp-frame { position: absolute; inset: 0; pointer-events: none; animation: mp-frame-in 200ms cubic-bezier(0.19, 1, 0.22, 1) both; }
  .mp-glow { position: absolute; inset: 0; border-radius: 2px; will-change: opacity;
             box-shadow: inset 0 0 15px rgba(217,119,87,.7), inset 0 0 25px rgba(217,119,87,.5), inset 0 0 35px rgba(217,119,87,.2);
             animation: mp-breathe 2400ms ease-in-out 200ms infinite; }
  .mp-pill { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); pointer-events: none;
             display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 12px;
             background: #faf9f5; color: #141413; border: .5px solid rgba(31,30,29,.4); box-shadow: 0 40px 80px rgba(217,119,87,.24), 0 4px 14px rgba(217,119,87,.24);
             font: 500 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; white-space: nowrap;
             animation: mp-pill-in 200ms cubic-bezier(0.19, 1, 0.22, 1) both; }
  .mp-pill.mp-top { bottom: auto; top: 16px; }
  .mp-pill.mp-live { pointer-events: auto; }
  .mp-dot { width: 8px; height: 8px; border-radius: 50%; background: #d97757; box-shadow: 0 0 0 3px rgba(217,119,87,.2); }
  .mp-stop, .mp-review, .mp-go { all: unset; cursor: pointer; padding: 3px 6px; border-radius: 6px; color: #141413;
             font: 600 12px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
             transition: background-color 120ms cubic-bezier(0.32, 0.72, 0, 1); }
  .mp-stop:hover, .mp-review:hover, .mp-go:hover { background: rgba(31,30,29,.08); }
  .mp-stop:focus-visible, .mp-review:focus-visible, .mp-go:focus-visible { outline: 2px solid #2f6fed; outline-offset: 2px; }
  .mp-stop:disabled { cursor: default; opacity: .6; }
  .mp-review[hidden], .mp-go[hidden], .mp-frame[hidden] { display: none; }
  .mp-waiting .mp-dot { background: #facc15; box-shadow: 0 0 0 3px rgba(250,204,21,.3); }
  @keyframes mp-frame-in { from { opacity: 0; } }
  @keyframes mp-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .68; } }
  @keyframes mp-pill-in { from { opacity: 0; transform: translate(-50%, 8px); } }
  @media (prefers-reduced-motion: reduce) {
    .mp-frame, .mp-pill { animation: mp-frame-in 120ms linear both; } .mp-glow, .mp-stop, .mp-review, .mp-go { animation: none; transition: none; } }`;

/** The binding Stop calls (Runtime.addBinding, in the cursor's world only). */
const STOP_BINDING = '__mopilotStop';

module.exports = { controlFrame, FRAME_CSS, STOP_BINDING, FRAME_SOURCE: `(${controlFrame.toString()})` };
