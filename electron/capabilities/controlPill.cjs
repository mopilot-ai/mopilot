// The clickable part of the control indicator (#1579): while a chat controls the desktop, a small pill at the top-right
// corner of every display, "Claude is using [icon] Notes" and a Stop button, that a person can click. The full-screen
// glow (controlIndicator.cjs) stays click-through; this window is sized to the pill, so it takes only the clicks that
// land on it. Like the glow it sits at the screen-saver level and opts out of capture, so screenshots never show it.
// The page runs no script: Stop and the label are links, and main takes their navigation as the click (will-navigate)
// and cancels it. The label opens the chat in control, as Claude Desktop's badge does.
// An agent's own clicks must never land on it: MoPilot's helper posts them through suspendPointer(), which makes the
// pill click-through for the action, and while Codex Computer Use (Sky) holds the desktop, which posts clicks MoPilot
// cannot fence, the pill is click-through and says "Esc to stop" in place of the Stop button (Esc and the tray still stop).

const { noteIgnored } = require('../ignored.cjs');
const { ControlIndicator } = require('./controlIndicator.cjs');
const { usingText } = require('./computerPresentation.cjs');

const LABEL = usingText(null);
/** The navigation a Stop click starts; main cancels it and stops the chat. Never loaded (.invalid). */
const STOP_URL = 'https://control.mopilot.invalid/stop';
/** The navigation a click on the label starts; main cancels it and opens the chat in control. Never loaded. */
const OPEN_URL = 'https://control.mopilot.invalid/open';
/** What the pill says while it can't take clicks (Codex Computer Use holds the desktop). */
const ESC_HINT = 'Esc to stop';
/** The pill window: wide enough for the label, the Stop button and its padding at 13px. */
const SIZE = { width: 340, height: 40 };
/** How far in from the display's top-right corner, where the overlay's badge flies to. */
const INSET = 32;
/** How long after the overlay appears the pill comes in: when the badge's flight to the corner ends. */
const DELAY_MS = 5700;
/** How long the pill stays click-through after the agent's pointer action, for the window server to deliver it. */
const POINTER_SETTLE_MS = 150;
/**
 * Helper requests that post a pointer event at a screen point: they run with the pill click-through, so the event
 * reaches the app the helper's hit test looked through to.
 */
const POINTER = new Set(['input.click', 'input.drag', 'input.move', 'input.scroll', 'input.button']);
/** MoPilot's accent (tokens.css --accent, dark), for the working dot. */
const RGB = '214,118,79';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * What the pill names: the chat's agent, and whether the person took over from it.
 * @typedef {{ agent: string, paused?: boolean }} PillWho
 */

/**
 * The pill's text, as every desktop-level surface says it: "{agent} is using your computer", or "You took over" while
 * the person has it. A clickable pill's label opens the chat; a click-through one has no links and says how to stop.
 */
function pillLabel(/** @type {PillWho | null} */ who, clickable = true) {
  const text = esc(!who ? LABEL : who.paused ? 'You took over' : usingText(who.agent));
  return clickable
    ? `<a id="label" href="${OPEN_URL}" draggable="false" title="Open the chat">${text}</a>`
    : `<span id="label">${text} · ${ESC_HINT}</span>`;
}

/** The pill page: no script, two links (the label, Stop; none when click-through) and a fade-in. A quiet dark capsule, as Claude Desktop's badge. */
function pillHtml(/** @type {PillWho | null} */ who = null, clickable = true) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
#pill{box-sizing:border-box;position:fixed;inset:2px;display:flex;align-items:center;gap:8px;background:rgba(38,37,34,.94);border:0.5px solid rgba(255,255,255,.12);border-radius:999px;padding:0 5px 0 14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;font-weight:500;color:rgba(255,255,255,.92);white-space:nowrap;animation:pill-in .3s ease-in-out}
#dot{flex:none;width:7px;height:7px;border-radius:50%;background:rgb(${RGB});animation:dot-pulse 2s cubic-bezier(.4,0,.6,1) infinite}
#label{flex:1;display:flex;align-items:center;gap:5px;overflow:hidden;text-overflow:ellipsis}
#label b{font-weight:600}
a#label{color:inherit;text-decoration:none;cursor:pointer}
a#label:hover{text-decoration:underline}
#icon{flex:none;width:16px;height:16px}
#stop{flex:none;padding:4px 12px;border-radius:999px;border:0.5px solid rgba(255,255,255,.18);color:rgba(255,255,255,.92);text-decoration:none;cursor:pointer}
#stop:hover{background:rgba(255,255,255,.1)}
@keyframes pill-in{from{opacity:0}to{opacity:1}}
@keyframes dot-pulse{0%,100%{opacity:1}50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){#pill,#dot{animation:none}}
</style></head><body><div id="pill"><div id="dot"></div>${pillLabel(who, clickable)}${clickable ? `<a id="stop" href="${STOP_URL}" draggable="false">Stop</a>` : ''}</div></body></html>`;
}

/** Where the pill sits on a display: its top-right corner, INSET in. */
function pillBounds(display) {
  const b = display.bounds;
  return { x: Math.round(b.x + b.width - INSET - SIZE.width), y: Math.round(b.y + INSET), ...SIZE };
}

class ControlPills {
  /**
   * @param {object} o
   * @param {{ BrowserWindow: any, screen: any } | null} o.electron Electron's main-process modules
   * @param {() => void} [o.onStop] a person clicked Stop (the indicator sets it to stop the chat holding control)
   * @param {() => void} [o.onOpen] a person clicked the label (the indicator sets it to open the chat holding control)
   * @param {(chatId: string) => Promise<PillWho | null>} [o.who] the agent and app the pill names for the chat in control
   *   (a paired device using this Mac is named as the one using it, not this Mac's agent)
   * @param {number} [o.delayMs] how long after show() the pills come in (with reduced motion, the badge waits still
   *   in the corner until then)
   * @param {number} [o.settleMs] how long a pill stays click-through after an agent's pointer action
   */
  constructor(o) {
    this.electron = o.electron || null;
    this.onOpen =
      o.onOpen ||
      (() => {
        /* set by the indicator */
      });
    this.onStop =
      o.onStop ||
      (() => {
        /* set by the indicator */
      });
    this.who = o.who || (async () => null);
    /** the page every pill shows (pillHtml) */
    /** @type {PillWho | null} what the pills name, as the last rename answered */
    this.named = null;
    this.html = pillHtml(null);
    this.delayMs = o.delayMs ?? DELAY_MS;
    this.settleMs = o.settleMs ?? POINTER_SETTLE_MS;
    /** one per display, reused across shows */
    this.windows = [];
    /** whether a person's click may reach the pills (false while an agent posts clicks MoPilot can't fence) */
    this.clickable = true;
    /** agent pointer actions in flight */
    this.suspended = 0;
    this.up = false;
    /** the latest naming in flight: an older one's answer is dropped */
    this.asking = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
  }

  /**
   * Shows the pills once the badge's flight ends; `clickable` says whether a person's click may reach them. Each show
   * names `chatId`'s agent and app again (the app changes as the chat moves on): a page that changed is reloaded.
   */
  show(clickable = true, chatId = null) {
    const changed = clickable !== this.clickable;
    this.clickable = clickable;
    // the page differs by whether it can be clicked: a pill already up follows
    if (changed) this.#refresh();
    if (chatId) this.#rename(chatId);
    this.up = true;
    this.#applyMouse();
    if (this.timer || this.windows.some((w) => !w.isDestroyed?.() && w.isVisible?.())) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.up) this.#place();
    }, this.delayMs);
  }

  /** Names the chat's agent and app, unless a later show or a hide came first. */
  #rename(chatId) {
    const ask = (this.asking = {});
    this.who(chatId).then(
      (who) => {
        if (this.asking !== ask || !this.up) return;
        this.named = who;
        this.#refresh();
      },
      (error) => noteIgnored('name the app on the control pill', error),
    );
  }

  /** Loads the page again when what it says changed (who it names, whether it can be clicked). */
  #refresh() {
    const html = pillHtml(this.named, this.clickable);
    if (html === this.html) return;
    this.html = html;
    for (const w of this.windows) if (!w.isDestroyed?.()) this.#load(w);
  }

  #load(w) {
    w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.html)}`).catch((error) => {
      // a failed load leaves the pill blank; Esc and the tray still stop
      noteIgnored('load the control pill', error);
    });
  }

  hide() {
    this.up = false;
    this.asking = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.windows) {
      try {
        if (!w.isDestroyed?.()) w.hide();
      } catch (error) {
        // the window may already be destroyed
        noteIgnored('hide the control pill', error);
      }
    }
  }

  dispose() {
    this.hide();
    for (const w of this.windows) {
      try {
        w.destroy();
      } catch (error) {
        // the window may already be destroyed
        noteIgnored('close the control pill', error);
      }
    }
    this.windows = [];
  }

  /**
   * Runs an agent's pointer action with every pill click-through, so the click lands on the app below, as the helper's
   * hit test (which looks through MoPilot's capture-excluded windows) approved it. The pills take clicks again
   * `settleMs` after the last action settles, once the window server has delivered it.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async suspendPointer(fn) {
    this.suspended++;
    this.#applyMouse();
    try {
      return await fn();
    } finally {
      const release = () => {
        this.suspended--;
        this.#applyMouse();
      };
      if (this.settleMs > 0) setTimeout(release, this.settleMs);
      else release();
    }
  }

  /** Each pill takes a person's clicks only when clickable and no agent pointer action is in flight. */
  #applyMouse() {
    const ignore = !this.clickable || this.suspended > 0;
    for (const w of this.windows) {
      try {
        if (!w.isDestroyed?.()) w.setIgnoreMouseEvents(ignore);
      } catch (error) {
        // the window may already be destroyed
        noteIgnored('set whether the control pill takes clicks', error);
      }
    }
  }

  #place() {
    const e = this.electron;
    if (!e?.BrowserWindow || !e.screen) return;
    let displays = [];
    try {
      displays = e.screen.getAllDisplays();
    } catch (error) {
      // no screen info: no pill (Esc and the tray still stop)
      noteIgnored('list the displays for the control pill', error);
    }
    while (this.windows.length > displays.length) {
      const w = this.windows.pop();
      try {
        w.destroy();
      } catch (error) {
        // the window may already be destroyed
        noteIgnored('close the control pill on a removed display', error);
      }
    }
    displays.forEach((d, i) => {
      let w = this.windows[i];
      try {
        if (!w || w.isDestroyed?.()) w = this.windows[i] = this.#makeWindow(e);
        w.setBounds(pillBounds(d));
        w.showInactive();
      } catch (error) {
        // the pill is a convenience: Esc and the tray still stop
        noteIgnored('show the control pill', error);
      }
    });
    this.#applyMouse();
  }

  /** @param {{ BrowserWindow: any }} e */
  #makeWindow(e) {
    const w = new e.BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // clicked without taking focus from the app the agent works in
      focusable: false,
      acceptFirstMouse: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'MoPilot control pill',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    // never in a screenshot or a screen share: an agent never sees it, so never aims at it
    w.setContentProtection(true);
    w.webContents.on('will-navigate', (/** @type {{ preventDefault(): void }} */ event, /** @type {string} */ url) => {
      event.preventDefault();
      if (!this.up || !this.clickable || this.suspended) return;
      if (url === STOP_URL) this.onStop();
      else if (url === OPEN_URL) this.onOpen();
    });
    w.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    this.#load(w);
    return w;
  }
}

/**
 * Sends every POINTER request of `helper` (electron/capabilities/computer.cjs) through `pills.suspendPointer`.
 * @param {{ call(method: string, ...rest: any[]): Promise<any> }} helper
 * @param {{ suspendPointer<T>(fn: () => Promise<T>): Promise<T> }} pills
 */
function fencePointer(helper, pills) {
  const call = helper.call.bind(helper);
  helper.call = (method, ...rest) => (POINTER.has(method) ? pills.suspendPointer(() => call(method, ...rest)) : call(method, ...rest));
}

/**
 * The control indicator with its clickable pill: Stop goes where Esc does, an Escape the agent sent (the helper's, or
 * Codex's own computer use) is not a person's stop, and the helper's pointer requests pass through the pill.
 * @param {{ call(method: string, ...rest: any[]): Promise<any>, escapeSender(): Promise<string> }} helper
 * @param {ConstructorParameters<typeof ControlIndicator>[0] & { who?: (chatId: string) => Promise<PillWho | null> }} o
 */
function indicatorWithPill(helper, o) {
  const pills = new ControlPills({ electron: o.electron, who: o.who });
  fencePointer(helper, pills);
  return new ControlIndicator({ escapeSender: () => helper.escapeSender(), ...o, pills });
}

module.exports = {
  ControlPills,
  indicatorWithPill,
  fencePointer,
  POINTER,
  pillHtml,
  pillLabel,
  pillBounds,
  STOP_URL,
  OPEN_URL,
  ESC_HINT,
  LABEL,
  SIZE,
  INSET,
  DELAY_MS,
  POINTER_SETTLE_MS,
};
