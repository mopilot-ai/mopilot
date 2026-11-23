// The agent cursor's overlay, run in the page's own isolated world (agentCursor.cjs injects it serialized): the pointer
// gliding on the Codex app's springs, the click ring at arrival, the typed field's highlight and the label, concealing
// for screenshots and idle removal. It must not close over anything: it is sent to the page as source.

const { labelText } = require('../../../shared/labelText.mjs');

/* eslint-disable no-restricted-globals */
/** Runs in the cursor world (serialized with toString: it must not close over anything). */
function cursorOverlay(idleMs, control, joinLabels = labelText, travelMax = 500) {
  const G = globalThis;
  if (G.__mopilotCursor) return G.__mopilotCursor;
  /** @type {{ avoid: (y: number | null) => void, leave: (host: HTMLElement) => void, status: (s: string) => void, role: (r: string) => void } | null} the control frame, while mounted (with `control`) */
  let frame = null;
  /** with `control`: the chat's turn, 'running' or 'waiting' (for the user's OK) */
  let status = 'running';
  /** with `control`: 'front' on the tab the agent works on, 'group' on the chat's other tabs it holds */
  let role = 'front';
  /** with `control`: the tab's favicon mark (agentTabMark.cjs) */
  const marks = control && control.mark ? control.mark() : null;
  /** The favicon follows the turn and the tab's role while the frame shows. */
  const sync = () => {
    // the pointer only where the agent works; the yellow dot on every tab while the chat waits
    const want = status === 'waiting' ? 'waiting' : role === 'group' ? null : 'active';
    if (marks && marks.state !== want) marks.set(want);
  };
  /** @type {ReturnType<typeof setTimeout> | undefined} with `control`: when the frame goes by itself */
  let life;
  /** @typedef {{ layer: HTMLDivElement, focus: HTMLDivElement, pointer: HTMLDivElement, label: HTMLDivElement }} Parts */
  /** @type {HTMLElement | null} */
  let host = null;
  /** @type {Parts | null} set together with `host` by mount(), cleared together by clear() */
  let parts = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idle;
  /** @type {{ x: number, y: number } | null} */
  let at = null;
  /** Date.now() when the running glide arrives (a click's ripple plays then) */
  let arriveAt = 0;
  /** true while the pointer is faded out after a click (the next action brings it back in from afar) */
  let faded = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} the fade-out after a click */
  let fadeTimer;
  /** @type {Animation[]} the running planned glides (pointer, label) */
  let glides = [];
  // Codex's travel: a hop up to 196 px glides 175 ms, a longer one 1.4 ms more per px up to travelMax; under 4 px none
  const travelMs = (d) => (d < 4 ? 0 : d <= 196 ? 175 : Math.min(travelMax, Math.round(175 + (d - 196) * 1.4)));
  const still = () => document.visibilityState === 'hidden' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // The Codex app's agent cursor: a two-layer glow, and springs (response, damping fraction) sampled as
  // linear() easings: it appears from scale .4 and a 5px blur on its visibility spring (0.42, 0.86; 585ms
  // to settle) and glides on its position spring (0.19, 0.9; 175ms). The spring-in plays each time the overlay is
  // mounted (an agent's first action, or the first after it idled out), not after a screenshot hid it.
  const GLIDE =
    'transform 175ms linear(0, 0.0527, 0.1703, 0.3105, 0.4492, 0.574, 0.6795, 0.7651, 0.832, 0.8829, 0.9206, 0.9478, 0.9669, 0.9801, 0.9888, 0.9944, 1), opacity 200ms';
  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 2147483647; }
    .layer.concealed { visibility: hidden; }
    .pointer { position: absolute; left: 0; top: 0; width: 22px; height: 22px; transition: ${GLIDE};
               filter: drop-shadow(0 0 6px color-mix(in srgb, #2f6fed 90%, transparent)) drop-shadow(0 0 15px color-mix(in srgb, #2f6fed 48%, transparent)); }
    .pointer svg { transform-origin: 3px 2px; animation: mp-appear 585ms linear(0, 0.0745, 0.2322, 0.4081, 0.5694, 0.7024, 0.8045, 0.8785, 0.9294, 0.9628, 0.9834, 0.9953, 1.0016, 1.0043, 1.005, 1.0047, 1.0039, 1.003, 1.0022, 1.0015, 1) both; }
    .label { position: absolute; left: 0; top: 0; max-width: 280px; padding: 3px 8px; border-radius: 10px; background: #2f6fed; color: #fff;
             font: 500 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
             transition: ${GLIDE}; box-shadow: 0 1px 3px rgba(0,0,0,.25); }
    .ripple { position: absolute; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; border: 2px solid #2f6fed; background: rgba(47,111,237,.18);
              animation: mp-ripple 600ms ease-out forwards; }
    .ripple.press { animation: mp-press 280ms ease-out forwards; }
    .focus { position: absolute; border-radius: 4px; box-shadow: 0 0 0 2px #2f6fed, 0 0 0 6px rgba(47,111,237,.25); animation: mp-pulse 1.2s ease-in-out infinite; transition: all 200ms; }
    @keyframes mp-appear { from { transform: scale(.4); filter: blur(5px); opacity: 0; } }
    @keyframes mp-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
    @keyframes mp-press { from { transform: scale(.3); opacity: .9; } to { transform: scale(1.25); opacity: 0; } }
    @keyframes mp-pulse { 50% { box-shadow: 0 0 0 2px #2f6fed, 0 0 0 9px rgba(47,111,237,.12); } }
    @media (prefers-reduced-motion: reduce) { .pointer, .label, .focus { transition: none; } .ripple, .focus, .pointer svg { animation: none; } }`;
  const SVG = 'http://www.w3.org/2000/svg';
  const div = (cls) => {
    const e = document.createElement('div');
    e.className = cls;
    return e;
  };

  // built with DOM calls and a constructed stylesheet: no markup parsing a page's CSP or Trusted Types would refuse
  const mount = () => {
    if (host && host.isConnected) return true;
    const root = document.documentElement;
    if (!root) return false;
    host = document.createElement('mopilot-agent-cursor');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS + (control ? control.css : ''));
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS + (control ? control.css : '');
      shadow.appendChild(style);
    }
    parts = { layer: div('layer'), focus: div('focus'), pointer: div('pointer'), label: div('label') };
    parts.focus.hidden = true;
    parts.label.hidden = true;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 22 22');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    const arrow = document.createElementNS(SVG, 'path');
    for (const [k, v] of [
      ['d', 'M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19 L10.5 12.8 L16.5 12.8 Z'],
      ['fill', '#2f6fed'],
      ['stroke', '#fff'],
      ['stroke-width', '1.5'],
      ['stroke-linejoin', 'round'],
    ])
      arrow.setAttribute(k, v);
    svg.appendChild(arrow);
    parts.pointer.appendChild(svg);
    parts.layer.append(parts.focus, parts.pointer, parts.label);
    shadow.appendChild(parts.layer);
    if (control) {
      // with no action yet (a page the agent only reads) the frame shows alone
      parts.pointer.hidden = true;
      frame = control.frame({
        layer: parts.layer,
        stop: (payload) => {
          const call = G[control.binding];
          if (typeof call !== 'function') return false;
          call(payload);
          return true;
        },
      });
      frame?.status(status);
      frame?.role(role);
    }
    root.appendChild(host);
    return true;
  };

  /** Removes the overlay; `final` is the tab's turn-end favicon mark ('deliverable', 'handoff'), none when it goes otherwise. */
  const clear = (final) => {
    marks?.set(typeof final === 'string' ? final : null);
    clearTimeout(idle);
    idle = undefined;
    clearTimeout(life);
    life = undefined;
    at = null;
    arriveAt = 0;
    faded = false;
    clearTimeout(fadeTimer);
    fadeTimer = undefined;
    glides = [];
    if (host) (frame ? frame.leave : (h) => h.remove())(host);
    frame = null;
    host = null;
    parts = null;
    return true;
  };

  /** The element that has focus, through open shadow roots (an iframe stands for what's inside it). */
  const focused = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body && el !== document.documentElement ? el : null;
  };

  /** A field's name for the label: never its value. */
  const fieldName = (el) => {
    const label = el.labels ? joinLabels([...el.labels].map((l) => l.innerText || l.textContent)) : '';
    const name =
      el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    const t = String(name).replace(/\s+/g, ' ').trim();
    return t.length > 40 ? `${t.slice(0, 39).replace(/[\uD800-\uDBFF]$/, '')}…` : t;
  };

  const labelAt = (x, y) => {
    const w = window.innerWidth || 0;
    return x + 22 + 290 > w ? `translate(calc(${x - 10}px - 100%), ${y + 18}px)` : `translate(${x + 18}px, ${y + 18}px)`;
  };
  const place = (x, y, ms = 175) => {
    at = { x, y };
    // only called while the overlay is mounted
    const p = /** @type {Parts} */ (parts);
    p.pointer.style.transitionDuration = p.label.style.transitionDuration = `${ms}ms, 200ms`;
    p.pointer.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    p.label.style.transform = labelAt(x, y);
  };

  /** Brings the pointer back after a click's fade-out, and spring-in again from its small, blurred start. */
  const reappear = (p) => {
    clearTimeout(fadeTimer);
    fadeTimer = undefined;
    if (!faded) return;
    faded = false;
    p.pointer.style.opacity = p.label.style.opacity = '';
    const svg = p.pointer.firstChild;
    if (svg) {
      svg.style.animation = 'none';
      svg.getBoundingClientRect();
      svg.style.animation = '';
    }
  };

  /**
   * One planned approach (shared/cursorApproach.mjs, planned in main): the pointer starts at the plan's start point, comes in along its
   * sampled path (a straight, critically damped spring) and rests on (x, y). The samples play as one linear Web Animation, so the page's
   * frame rate and not the plan's decides what is drawn.
   */
  const glide = (p, plan, x, y) => {
    for (const g of glides) g.cancel();
    glides = [];
    reappear(p);
    place(x, y, 0);
    if (typeof p.pointer.animate !== 'function' || !(plan.durationMs > 0)) return;
    // a start near the page's edge stays on the page (the path is a straight line, so clamping bends it only there)
    const w = window.innerWidth || Infinity;
    const h = window.innerHeight || Infinity;
    const frames = (at2) =>
      plan.path.map(([t, px, py]) => ({
        offset: Math.min(1, t / plan.durationMs),
        transform: at2(Math.min(Math.max(px, 0), w), Math.min(Math.max(py, 0), h)),
      }));
    const opts = { duration: plan.durationMs, easing: 'linear', fill: 'backwards' };
    glides = [
      p.pointer.animate(
        frames((px, py) => `translate(${px - 3}px, ${py - 2}px)`),
        opts,
      ),
      p.label.animate(frames(labelAt), opts),
    ];
  };

  /** After a click the pointer lingers `ms`, then fades; the next action brings it back in from afar. */
  const fadeAfter = (p, ms) => {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      faded = true;
      p.pointer.style.opacity = p.label.style.opacity = '0';
    }, ms);
  };

  const api = {
    /**
     * One action: { x?, y?, from?: {x, y}, to?: {x, y}, click?: boolean, focus?: boolean, label: string }; returns
     * { ms, x, y }: how long until the pointer arrives at (x, y)
     */
    show(a) {
      if (!mount()) return false;
      // mount() succeeded, so the overlay's parts exist
      const p = /** @type {Parts} */ (parts);
      p.layer.classList.remove('concealed');
      if (control) {
        clearTimeout(life);
        life = setTimeout(clear, control.lifeMs);
        if (a.frame) {
          status = a.status === 'waiting' ? 'waiting' : 'running';
          role = a.role === 'group' ? 'group' : 'front';
          frame?.status(status);
          frame?.role(role);
        }
        sync();
        // the frame alone: the agent works on the tab, with no pointer action yet
        if (a.frame) return true;
      }
      clearTimeout(idle);
      // with the frame the pointer only fades; the frame stays until the turn ends
      idle = setTimeout(
        control
          ? () => {
              // clear() stops this timer with the parts, so they are there
              p.pointer.hidden = true;
              p.label.hidden = true;
              // the next action brings it in from afar again, as after a click
              at = null;
            }
          : clear,
        idleMs,
      );
      p.pointer.hidden = false;
      let x = Number.isFinite(a.x) ? a.x : null;
      let y = Number.isFinite(a.y) ? a.y : null;
      let label = String(a.label || '');
      p.focus.hidden = true;
      if (a.focus) {
        const el = focused();
        if (el) {
          const r = el.getBoundingClientRect();
          Object.assign(p.focus.style, {
            left: `${r.left - 2}px`,
            top: `${r.top - 2}px`,
            width: `${r.width + 4}px`,
            height: `${r.height + 4}px`,
          });
          p.focus.hidden = false;
          const n = fieldName(el);
          if (n) label += ` in “${n}”`;
          if (x == null) {
            x = r.left + Math.min(r.width - 4, 12);
            y = r.top + r.height / 2;
          }
        }
      }
      // no point: where the pointer is, else the middle of the viewport
      if (x == null) {
        x = at ? at.x : (window.innerWidth || 0) / 2;
        y = at ? at.y : (window.innerHeight || 0) / 2;
      }
      // the agent's input must not land on the frame's Stop
      frame?.avoid(a.to && Number.isFinite(a.to.y) ? Math.max(y, a.to.y) : y);
      // a new overlay (the tab's first action, a new page) glides in from the tab's last point, else a resting point
      const from = at ?? (a.from && Number.isFinite(a.from.x) && Number.isFinite(a.from.y) ? a.from : null);
      const start = from ?? { x: (window.innerWidth || 0) * 0.58, y: (window.innerHeight || 0) * 0.55 };
      const quiet = !!(a.still || still());
      // a planned approach (the Codex app's: it comes in from afar, clicks, and goes) when the pointer is not on the page now
      const planned = !quiet && a.plan && Array.isArray(a.plan.path) && a.plan.path.length > 1 ? a.plan : null;
      const plan = planned && (faded || !at) ? planned : null;
      const ms = plan ? Math.round(plan.durationMs + plan.hoverMs) : quiet ? 0 : travelMs(Math.hypot(x - start.x, y - start.y));
      const now = Date.now();
      if (plan) {
        glide(p, plan, x, y);
        arriveAt = now + ms;
      } else {
        reappear(p);
        // a planned glide still running is let go: the new move starts from where it was heading, and the action waits for the new one
        for (const g of glides) g.cancel();
        glides = [];
        if (!at) {
          place(start.x, start.y, 0);
          p.pointer.getBoundingClientRect();
        }
        // a point the running glide is already on its way to: it keeps going (a 0 ms move would cut it short)
        if (ms || arriveAt <= now) place(x, y, ms);
        arriveAt = ms ? now + ms : Math.max(arriveAt, now);
      }
      const wait = arriveAt - now;
      if (a.click) {
        const ripple = () => {
          if (!parts) return;
          const r = document.createElement('div');
          r.className = planned ? 'ripple press' : 'ripple';
          r.style.left = `${x}px`;
          r.style.top = `${y}px`;
          parts.layer.appendChild(r);
          setTimeout(() => r.remove(), planned ? 360 : 700);
        };
        // the ring plays where the pointer lands, when it lands
        if (wait) setTimeout(ripple, wait);
        else ripple();
        // a click that follows another inside its linger still fades: the planned click always does
        if (planned) fadeAfter(p, wait + planned.hideAfterClickMs);
      }
      if (a.to && Number.isFinite(a.to.x) && Number.isFinite(a.to.y)) setTimeout(() => parts && place(a.to.x, a.to.y), Math.max(280, wait));
      p.label.textContent = label;
      p.label.hidden = !label;
      return { ms: wait, x, y };
    },
    /** Hidden (true) or shown again (false); resolves after a frame so a capture doesn't catch it. */
    conceal(on) {
      if (!parts) return false;
      parts.layer.classList.toggle('concealed', !!on);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(true), 100);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(t);
            resolve(true);
          }),
        );
      });
    },
    /** The chat's turn changed: the pill and the favicon say whether it waits for the user's OK. */
    status(s) {
      status = s === 'waiting' ? 'waiting' : 'running';
      frame?.status(status);
      if (host) sync();
      return true;
    },
    /** The agent moved to another of the chat's tabs ('group' here) or back to this one ('front'). */
    role(r) {
      role = r === 'group' ? 'group' : 'front';
      frame?.role(role);
      if (host) sync();
      return true;
    },
    clear,
  };
  G.__mopilotCursor = api;
  return api;
}
/* eslint-enable no-restricted-globals */

const CURSOR_SOURCE = `(${cursorOverlay.toString()})`;

module.exports = { cursorOverlay, CURSOR_SOURCE };
