// The teach-mode tooltip (desktop_teach_step): one small always-on-top window that shows the agent's explanation near a
// point on screen, with Exit and Next, then a quiet "Working" line while the agent runs the step's actions. Like the
// control pill (controlPill.cjs) the page runs no script of its own: Next and Exit are links, and main takes their
// navigation as the click and cancels it. The window opts out of capture, so screenshots never show it, and it is
// click-through while the agent works, so the agent's own clicks land on the app below.
/** The navigations a click on Next and on Exit start; main cancels them. Never loaded (.invalid). */
const NEXT_URL = 'https://teach.mopilot.invalid/next';
const EXIT_URL = 'https://teach.mopilot.invalid/exit';
/** The tooltip box, the space round it for the arrow and shadow, and the gaps the placement keeps. */
const WIDTH = 340;
const PAD = 18;
const ARROW = 10;
const ARROW_GAP = 16;
const EDGE = 20;
/** The height used when the page cannot be measured. */
const FALLBACK_HEIGHT = 150;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Where a tooltip of `size` goes for an `anchor` point on a display (all in global points): below the anchor when it
 * fits, else above, right, left (below when none fits), clamped to EDGE from the display's edges. No anchor: centered,
 * no arrow. `arrow` is the arrow's offset along the tooltip's edge.
 * @param {{ x: number, y: number } | null} anchor
 * @param {{ x: number, y: number, width: number, height: number }} d
 * @param {{ w: number, h: number }} size
 * @returns {{ left: number, top: number, side: 'none' | 'below' | 'above' | 'right' | 'left', arrow: number }}
 */
function placeTooltip(anchor, d, size) {
  const { w, h } = size;
  if (!anchor) return { left: Math.round(d.x + (d.width - w) / 2), top: Math.round(d.y + (d.height - h) / 2), side: 'none', arrow: 0 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ax = clamp(anchor.x, d.x + EDGE, d.x + d.width - EDGE);
  const ay = clamp(anchor.y, d.y + EDGE, d.y + d.height - EDGE);
  const fits = {
    below: ay + ARROW_GAP + h + EDGE <= d.y + d.height,
    above: ay - ARROW_GAP - h - EDGE >= d.y,
    right: ax + ARROW_GAP + w + EDGE <= d.x + d.width,
    left: ax - ARROW_GAP - w - EDGE >= d.x,
  };
  const side = /** @type {'below' | 'above' | 'right' | 'left'} */ (['below', 'above', 'right', 'left'].find((k) => fits[k]) ?? 'below');
  if (side === 'below' || side === 'above') {
    const left = clamp(Math.round(ax - w / 2), d.x + EDGE, Math.max(d.x + EDGE, d.x + d.width - w - EDGE));
    const top = Math.round(side === 'below' ? ay + ARROW_GAP : ay - ARROW_GAP - h);
    return { left, top, side, arrow: clamp(ax - left, ARROW + 6, w - ARROW - 6) };
  }
  const top = clamp(Math.round(ay - h / 2), d.y + EDGE, Math.max(d.y + EDGE, d.y + d.height - h - EDGE));
  const left = Math.round(side === 'right' ? ax + ARROW_GAP : ax - ARROW_GAP - w);
  return { left, top, side, arrow: clamp(ay - top, ARROW + 6, h - ARROW - 6) };
}

/**
 * The tooltip page. `step` is {explanation, nextPreview}; `working` swaps the buttons for "Working" and the Esc hint.
 * @param {{ explanation: string, nextPreview: string }} step
 * @param {{ side?: string, arrow?: number, working?: boolean }} [o]
 */
function tooltipHtml(step, o = {}) {
  const side = o.side ?? 'none';
  const arrow = side === 'none' ? '' : `<div id="arrow" class="${side}" style="--at:${Math.round(o.arrow ?? 0)}px"></div>`;
  const foot = o.working
    ? '<div id="foot"><span id="busy"></span><span id="work">Working…</span><span id="hint">Esc to stop</span></div>'
    : `<div id="foot"><a id="exit" href="${EXIT_URL}" draggable="false">Exit</a><a id="next" href="${NEXT_URL}" draggable="false">Next</a></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>MoPilot teach tooltip</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
:root{--bg:#fff;--fg:#1c1b19;--dim:#6b6a66;--line:rgba(0,0,0,.12);--hover:rgba(0,0,0,.06);--accent:rgb(214,118,79);--btn:#1c1b19;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#262522;--fg:#f4f3ee;--dim:#a9a8a1;--line:rgba(255,255,255,.14);--hover:rgba(255,255,255,.08);--btn:#f4f3ee;--btnfg:#1c1b19}}
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default;font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--fg)}
#wrap{position:fixed;inset:${PAD}px}
#tip{box-sizing:border-box;width:100%;background:var(--bg);border:.5px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,.28);animation:in .2s ease-out}
#dot{width:8px;height:8px;border-radius:50%;background:var(--accent);margin-bottom:8px}
#say{white-space:pre-wrap;word-wrap:break-word}
#preview{margin-top:8px;font-size:12px;color:var(--dim)}
#foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px;font-size:13px;font-weight:500}
#foot a{padding:5px 14px;border-radius:999px;text-decoration:none;cursor:pointer;color:var(--fg);border:.5px solid var(--line)}
#foot a:hover{background:var(--hover)}
#foot a#next{background:var(--btn);color:var(--btnfg);border-color:transparent}
#busy{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--line);border-top-color:var(--accent);animation:spin .9s linear infinite}
#work{flex:1;text-align:left}
#hint{color:var(--dim);font-weight:400;font-size:12px}
#arrow{position:absolute;width:0;height:0;border:${ARROW}px solid transparent}
#arrow.below{top:-${ARROW * 2}px;left:calc(var(--at) - ${ARROW}px);border-bottom-color:var(--bg)}
#arrow.above{bottom:-${ARROW * 2}px;left:calc(var(--at) - ${ARROW}px);border-top-color:var(--bg)}
#arrow.right{left:-${ARROW * 2}px;top:calc(var(--at) - ${ARROW}px);border-right-color:var(--bg)}
#arrow.left{right:-${ARROW * 2}px;top:calc(var(--at) - ${ARROW}px);border-left-color:var(--bg)}
@keyframes in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#tip,#busy{animation:none}}
</style></head><body><div id="wrap"><div id="tip">${arrow}<div id="dot"></div><div id="say">${esc(step.explanation)}</div>${
    step.nextPreview ? `<div id="preview">${esc(step.nextPreview)}</div>` : ''
  }${foot}</div></div></body></html>`;
}

/**
 * @typedef {{ explanation: string, nextPreview: string, anchor: { x: number, y: number } | null, near?: { x: number, y: number } | null }} TeachStepView
 * @typedef {'next' | 'exit' | 'cancel'} TeachChoice
 */

class TeachOverlay {
  /**
   * @param {object} o
   * @param {{ BrowserWindow: any, screen: any } | null} o.electron Electron's main-process modules
   * @param {(what: string, error: unknown) => void} o.note where an error that is survived is noted (ignored.cjs's noteIgnored)
   */
  constructor(o) {
    this.electron = o.electron || null;
    this.note = o.note;
    /** @type {any} */
    this.window = null;
    /** the step on screen until its tour ends: its chat, what it says and where it was placed */
    /** @type {{ chatId: string, step: TeachStepView, place: ReturnType<typeof placeTooltip> | null } | null} */
    this.view = null;
    /** answers the show that waits for a click */
    /** @type {((c: TeachChoice) => void) | null} */
    this.answer = null;
  }

  /** The tooltip's window, for the windows hidden during control to leave up. */
  windows() {
    return this.window && !this.window.isDestroyed?.() ? [this.window] : [];
  }

  /** Whether this process can draw the tooltip at all (the tool says teach mode is unavailable when not). */
  get available() {
    return !!(this.electron?.BrowserWindow && this.electron?.screen);
  }

  /**
   * Shows one step's tooltip and waits for the person: 'next', 'exit', or 'cancel' (the tour ended or a later step replaced it).
   * @param {string} chatId
   * @param {TeachStepView} step
   * @returns {Promise<TeachChoice>}
   */
  show(chatId, step) {
    this.#settle('cancel');
    return new Promise((resolve) => {
      const view = { chatId, step, place: null };
      this.view = view;
      this.answer = resolve;
      this.#present(view).catch((error) => {
        // no tooltip can be shown: the step ends as cancelled rather than waiting for a click that cannot come
        this.note('show the teach tooltip', error);
        if (this.view === view) this.#settle('cancel');
      });
    });
  }

  /** The step's Next was clicked: the tooltip says Working and lets the agent's clicks through. */
  working(chatId) {
    const w = this.window;
    const v = this.view;
    if (!v || v.chatId !== chatId || !w || w.isDestroyed?.()) return;
    this.#mouse(w, false);
    this.#load(w, tooltipHtml(v.step, { ...(v.place ?? {}), working: true })).catch((error) => {
      // the tooltip keeps its last page; the step still runs
      this.note('show the teach tooltip as working', error);
    });
  }

  /** The tour ended or the step was cancelled: the tooltip goes (a waiting show answers 'cancel'). */
  hide(chatId) {
    if (this.view?.chatId !== chatId) return;
    this.view = null;
    this.#settle('cancel');
    const w = this.window;
    if (!w || w.isDestroyed?.()) return;
    try {
      w.hide();
    } catch (error) {
      // the window may already be destroyed
      this.note('hide the teach tooltip', error);
    }
  }

  dispose() {
    this.view = null;
    this.#settle('cancel');
    try {
      this.window?.destroy();
    } catch (error) {
      // the window may already be destroyed
      this.note('close the teach tooltip', error);
    }
    this.window = null;
  }

  /** Answers the waiting show with `choice`. */
  #settle(choice) {
    const answer = this.answer;
    this.answer = null;
    answer?.(choice);
  }

  async #present(view) {
    const e = /** @type {NonNullable<TeachOverlay['electron']>} */ (this.electron);
    const w = this.window && !this.window.isDestroyed?.() ? this.window : (this.window = this.#makeWindow(e));
    const display = this.#displayFor(e, view.step);
    this.#mouse(w, true);
    await this.#load(w, tooltipHtml(view.step));
    // a later step replaced this one while its page loaded: the window is that step's now
    if (this.view !== view) return;
    const height = await this.#measure(w);
    if (this.view !== view) return;
    const place = placeTooltip(view.step.anchor, display, { w: WIDTH, h: height });
    view.place = place;
    await this.#load(w, tooltipHtml(view.step, place));
    if (this.view !== view) return;
    // the tooltip box is what was measured: the window is the box plus the space round it
    w.setBounds({ x: place.left - PAD, y: place.top - PAD, width: WIDTH + PAD * 2, height: height + PAD * 2 });
    w.showInactive();
  }

  #displayFor(e, step) {
    const at = step.anchor ?? step.near;
    const d = at ? e.screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.y) }) : e.screen.getPrimaryDisplay();
    return d.workArea ?? d.bounds;
  }

  /** The tooltip box's height at WIDTH, from the page itself; a fixed height when it cannot be read. */
  async #measure(w) {
    w.setBounds({ x: -10000, y: -10000, width: WIDTH + PAD * 2, height: 600 });
    try {
      const h = await w.webContents.executeJavaScript('document.getElementById("tip").offsetHeight');
      if (Number.isFinite(h) && h > 0) return Math.ceil(h);
    } catch (error) {
      // the page could not be measured: a fixed height still shows the whole tooltip for ordinary text
      this.note('measure the teach tooltip', error);
    }
    return FALLBACK_HEIGHT;
  }

  /** Loads a page and resolves when it is in. */
  #load(w, html) {
    return w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  /** Whether a person's click reaches the tooltip (it does while a step waits, never while the agent works). */
  #mouse(w, takesClicks) {
    try {
      w.setIgnoreMouseEvents(!takesClicks);
    } catch (error) {
      // the window may already be destroyed
      this.note('set whether the teach tooltip takes clicks', error);
    }
  }

  #makeWindow(e) {
    const w = new e.BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // clicked without taking focus from the app the tour is about
      focusable: false,
      acceptFirstMouse: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'MoPilot teach tooltip',
      // script is on only so main can measure the page; the page's CSP allows none of its own
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    // never in a screenshot or a screen share: the agent never sees it, so never aims at it
    w.setContentProtection(true);
    w.webContents.on('will-navigate', (/** @type {{ preventDefault(): void }} */ event, /** @type {string} */ url) => {
      event.preventDefault();
      if (url === NEXT_URL) this.#settle('next');
      else if (url === EXIT_URL) this.#settle('exit');
    });
    w.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    return w;
  }
}

module.exports = { TeachOverlay, placeTooltip, tooltipHtml, NEXT_URL, EXIT_URL, WIDTH, PAD, FALLBACK_HEIGHT };
