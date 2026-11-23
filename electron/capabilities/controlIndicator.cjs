// While a chat controls the desktop: a click-through, always-on-top overlay on every display (a soft
// glow around the edge and "Claude is using your computer · Esc to stop"), and a global Escape
// shortcut that stops that chat. The shortcut consumes Esc, so apps never see it while it is held.
// The overlay sits at the screen-saver level and opts out of capture: the helper's hit test looks
// through it, and screenshots never show it.
// Its motion matches Claude Desktop's computer-use overlay: it fades in and out over 0.3s, the glow
// breathes on a 2s cycle, and the badge appears large in the middle of the screen, then shrinks toward
// the top-right corner by 6s. Claude's badge fades out there; MoPilot's stays in the corner, so "Esc to
// stop" is on screen for as long as control lasts; with the clickable pill (controlPill.cjs) the badge hands the corner
// to it and fades out, as Claude's does. The page runs no script: main shows it by inserting
// a style sheet and hides it by removing that sheet, then hides the window once the fade-out is done.

const { usingText } = require('./computerPresentation.cjs');
const { noteIgnored, ignoring } = require('../ignored.cjs');
const LABEL = `${usingText(null)} · Esc to stop`;
/** The fade-out runs 0.3s; the window hides just after it. */
const FADE_MS = 320;
/** How long Esc-to-stop waits to learn who sent the Escape before it stops anyway. */
const ESCAPE_ASK_MS = 300;
/** The glow and badge colour (MoPilot's accent), as an rgb() triple. */
const RGB = '92,143,255';
/**
 * How long Esc stays lifted after the agent's own Escape was posted. The helper returns once the key is posted, and
 * the window server delivers it afterwards: a shortcut bound again at once can take the agent's own key as a stop.
 */
const ESCAPE_SETTLE_MS = 400;

/** Three inset rings of the glow, at one phase of its pulse: [blur px, alpha] each. */
function rings(...r) {
  return r.map(([blur, alpha]) => `inset 0 0 ${blur}px rgba(${RGB},${alpha})`).join(',');
}
const GLOW_REST = rings([50, 0.5], [100, 0.3], [150, 0.1]);
const GLOW_PEAK = rings([65, 0.7], [115, 0.5], [165, 0.2]);

/** Where the badge rests: the top-right corner, 40px in, at .8 scale. */
const CORNER = 'opacity:1;top:40px;left:calc(100% - 40px);transform:translate(-100%,0) scale(.8)';
/**
 * The badge's flight, Claude's badge-center-to-corner: centred at 1.4x, held there, then shrinking into the
 * corner. It ends in the corner rather than fading out.
 */
const FLIGHT = `0%{opacity:0;top:50%;left:50%;transform:translate(-50%,-50%) scale(1.4)}5%{opacity:1;top:50%;left:50%;transform:translate(-50%,-50%) scale(1.4)}88%{opacity:1;top:50%;left:50%;transform:translate(-50%,-50%) scale(1.4)}100%{${CORNER}}`;
/** The same flight under two names: each show takes the other one, so a show while shown restarts it. */
const FLIGHTS = ['badge-flight-a', 'badge-flight-b'];
/**
 * With the clickable pill (controlPill.cjs), the flight hands over to it: the badge reaches the corner, then fades out
 * as the pill fades in there, as Claude's badge does.
 */
const HANDOFF = `${FLIGHT.slice(0, FLIGHT.lastIndexOf('100%{'))}96%{${CORNER}}100%{${CORNER.replace('opacity:1', 'opacity:0')}}`;

/** The overlay page: no script, nothing to click, and invisible until a shownCss() sheet is inserted. */
function overlayHtml(label = LABEL) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;user-select:none;cursor:default}
#overlay{opacity:0;transition:opacity .3s ease-in-out}
#glow{position:fixed;inset:0;animation:glow-pulse 2s ease-in-out infinite;box-shadow:${GLOW_REST}}
#badge{position:fixed;display:flex;align-items:center;gap:8px;background:rgba(247,250,255,.95);border:1px solid rgba(${RGB},.2);border-radius:999px;padding:8px 16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;font-weight:600;color:rgb(${RGB});white-space:nowrap;opacity:0}
#badge-dot{width:8px;height:8px;border-radius:50%;background:rgb(${RGB});animation:dot-pulse 1.8s ease-in-out infinite}
@keyframes glow-pulse{0%,100%{box-shadow:${GLOW_REST}}50%{box-shadow:${GLOW_PEAK}}}
${FLIGHTS.map((name) => `@keyframes ${name}{${FLIGHT}}@keyframes ${name}-handoff{${HANDOFF}}`).join('')}
@keyframes dot-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}
@media (prefers-reduced-motion:reduce){#glow,#badge-dot{animation:none}}
</style></head><body><div id="overlay"><div id="glow"></div><div id="badge"><div id="badge-dot"></div><span>${esc(label)}</span></div></div></body></html>`;
}

/**
 * The sheet inserted for show number `n`: the overlay fades in and the badge flies to the corner (with reduced
 * motion, it is simply in the corner and the glow holds still). Removing it fades the overlay out. With `handoff`, the
 * pill takes the corner: the badge fades out once there (with reduced motion it waits there, under the pill).
 * @param {number} n
 * @param {boolean} [handoff]
 * @param {string | null} [label] the badge's words when not the page's own (labelCss)
 */
function shownCss(n, handoff = false, label = null) {
  const flight = handoff ? `${FLIGHTS[n % 2]}-handoff` : FLIGHTS[n % 2];
  return `#overlay{opacity:1}#badge{${CORNER}}@media (prefers-reduced-motion:no-preference){#badge{animation:${flight} 6s cubic-bezier(.4,0,.2,1) 1 forwards}}${labelCss(label)}`;
}

/**
 * The badge saying something else than the page's own label (a paired device controlling this Mac names itself), with
 * no script: the sheet hides the label and shows `label` as generated content, quoted as a CSS string.
 * @param {string | null} label
 */
function labelCss(label) {
  if (!label) return '';
  const quoted = `"${String(label)
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')}"`;
  return `#badge>span{display:none}#badge::after{content:${quoted}}`;
}

/**
 * Whether an Escape the shortcut received stops the turn. Only an agent's own key is ignored: the helper's post
 * (on any route) or one another process synthesized (Codex's computer use), as the helper's input guard saw it.
 * A person's, an unknown sender, a failed, slow or missing answer (no helper, an older helper) all stop, so a
 * person's Esc always works.
 * @param {(() => Promise<string>) | null} ask resolves to 'person', 'agent' or 'unknown'
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function escapeStops(ask, timeoutMs = ESCAPE_ASK_MS) {
  if (!ask) return true;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
  });
  try {
    const sender = await Promise.race([
      Promise.resolve()
        .then(ask)
        .catch((error) => {
          // the sender is unknown: the Escape stops, as a person's would
          noteIgnored('ask the computer-use helper who sent Escape', error);
          return 'unknown';
        }),
      late,
    ]);
    return sender !== 'agent';
  } finally {
    clearTimeout(timer);
  }
}

/** Drops `key` from `keys` if it is still there. */
function forget(keys, key) {
  const i = keys.indexOf(key);
  if (i >= 0) keys.splice(i, 1);
}

class ControlIndicator {
  /**
   * @param {object} o
   * @param {{ BrowserWindow: any, screen: any, globalShortcut: any } | null} o.electron Electron's main-process modules (null: nothing is shown)
   * @param {(chatId: string) => void} o.onEscape the user pressed Esc while `chatId` held control
   * @param {() => Promise<string>} [o.escapeSender] who sent the latest Escape ('person', 'agent' or 'unknown'):
   *   an agent's own Escape (the helper's, Codex's computer use) never stops the turn
   * @param {number} [o.escapeAskMs] how long to wait for that answer
   * @param {string} [o.label]
   * @param {(chatId: string | null) => string | null} [o.labelFor] the badge's words for the one holding control, when not the
   *   label (a remote owner of computer access, #1364: "<device> is using your computer · Esc to stop")
   * @param {number} [o.fadeMs] how long the windows stay up after the fade-out starts
   * @param {number} [o.escapeSettleMs] how long Esc stays lifted after the agent's own Escape (ESCAPE_SETTLE_MS)
   * @param {(chatId: string) => void} [o.onOpenChat] a person clicked the pill's label: bring the app to the front on `chatId`
   * @param {{ show(clickable?: boolean, chatId?: string | null): void, hide(): void, dispose(): void, windows: any[], onStop?: () => void, onOpen?: () => void } | null} [o.pills] the
   *   clickable pill (controlPill.cjs); without it the badge stays in the corner, saying "Esc to stop"
   * @param {(chatId: string) => boolean} [o.heldNatively] whether Codex Computer Use (Sky) holds the desktop for the chat:
   *   it posts clicks outside MoPilot's helper, which can't be kept off the pill, so the pill is click-through then
   * @param {(chatId: string) => boolean} [o.takenOver] whether the person took over from the chat in control: their keys,
   *   Esc included, go to their apps until they hand control back, so the Esc shortcut is lifted meanwhile (not while
   *   Codex Computer Use holds the desktop: its program doesn't pause, so Esc still stops it)
   */
  constructor(o) {
    this.electron = o.electron || null;
    this.onEscape =
      o.onEscape ||
      (() => {
        /* no Esc listener */
      });
    this.escapeSender = o.escapeSender || null;
    this.escapeAskMs = o.escapeAskMs ?? ESCAPE_ASK_MS;
    this.label = o.label || LABEL;
    this.labelFor = o.labelFor || (() => null);
    this.fadeMs = o.fadeMs ?? FADE_MS;
    this.escapeSettleMs = o.escapeSettleMs ?? ESCAPE_SETTLE_MS;
    this.onOpenChat =
      o.onOpenChat ||
      (() => {
        /* no chat to open */
      });
    this.pills = o.pills || null;
    this.heldNatively = o.heldNatively || (() => false);
    this.takenOver = o.takenOver || (() => false);
    // a person's click on the pill's Stop stops the chat holding control, as their Esc does
    if (this.pills) {
      this.pills.onStop = () => {
        if (this.chatId) this.onEscape(this.chatId);
      };
      // ... and one on its label opens the chat that holds control
      this.pills.onOpen = () => {
        if (this.chatId) this.onOpenChat(this.chatId);
      };
    }
    /** the chat holding control, or null */
    this.chatId = null;
    this.windows = [];
    this.escape = false;
    this.suspended = 0;
    /** bumped by every show and hide: a sheet or a hide timer from an earlier one is dropped */
    this.generation = 0;
    /** @type {Map<any, Promise<void>>} each window's page load */
    this.loaded = new Map();
    /** @type {Map<any, string[]>} each window's inserted shownCss() sheets, by the keys insertCSS gave */
    this.shown = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.hideTimer = null;
    /** @type {Map<any, number>} sheets inserted per window: consecutive ones name the flight differently, so each restarts it */
    this.flights = new Map();
  }

  /**
   * Shows the indicator for `chatId`, or (null) takes it down. Idempotent; called again when a native hold starts or
   * ends, so the pill follows whether a person may click it.
   * @param {string | null} chatId
   */
  sync(chatId) {
    const next = chatId || null;
    if (next) this.pills?.show(!this.heldNatively(next), next);
    if (next === this.chatId) {
      // taken over: the person's Esc is theirs; handed back: Esc stops the chat again
      if (next && this.#paused(next)) this.#unbindEscape();
      else if (next) this.#bindEscape();
      return;
    }
    this.chatId = next;
    if (next) {
      this.#showOverlay();
      if (!this.#paused(next)) this.#bindEscape();
    } else {
      this.#unbindEscape();
      this.#hideOverlay();
      this.pills?.hide();
    }
  }

  /** The indicator's windows: the overlays and the pills, which the windows hidden during control leave up. */
  allWindows() {
    return [...this.windows, ...(this.pills?.windows ?? [])];
  }

  /**
   * Runs `fn` with the Esc shortcut lifted, so an Escape the agent sends itself isn't taken as a stop. The shortcut
   * comes back `escapeSettleMs` after `fn` settles, once the posted key has been delivered; `fn`'s result does not wait.
   */
  async suspendEscape(fn) {
    this.suspended++;
    this.#unbindEscape();
    try {
      return await fn();
    } finally {
      const release = () => {
        this.suspended--;
        if (!this.suspended && this.chatId && !this.#paused(this.chatId)) this.#bindEscape();
      };
      if (this.escapeSettleMs > 0) setTimeout(release, this.escapeSettleMs);
      else release();
    }
  }

  dispose() {
    this.sync(null);
    this.pills?.dispose();
    this.#cancelHide();
    for (const w of this.windows) {
      try {
        w.destroy();
      } catch (error) {
        // the window may already be destroyed
        noteIgnored('close the control indicator overlay', error);
      }
    }
    this.windows = [];
    this.loaded.clear();
    this.shown.clear();
    this.flights.clear();
  }

  /** The person took over from the chat: never for Codex Computer Use, whose program keeps acting, so Esc must still stop it. */
  #paused(chatId) {
    return !this.heldNatively(chatId) && this.takenOver(chatId);
  }

  #bindEscape() {
    const gs = this.electron?.globalShortcut;
    if (!gs || this.escape || this.suspended) return;
    try {
      this.escape = !!gs.register('Escape', () => {
        const chatId = this.chatId;
        if (!chatId) return;
        if (!this.escapeSender) return this.onEscape(chatId);
        // the chat that held control when Esc came is the one a person meant to stop
        escapeStops(this.escapeSender, this.escapeAskMs).then((stops) => {
          if (stops) this.onEscape(chatId);
        }, ignoring('stop a chat on Esc'));
      });
    } catch {
      this.escape = false;
    }
  }

  #unbindEscape() {
    if (!this.escape) return;
    this.escape = false;
    try {
      this.electron?.globalShortcut?.unregister('Escape');
    } catch (error) {
      // the shortcut may already be released (e.g. app quitting)
      noteIgnored('release the Esc-to-stop shortcut', error);
    }
  }

  #cancelHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  #showOverlay() {
    const gen = ++this.generation;
    // shown again while fading out: the windows stay up and fade back in
    this.#cancelHide();
    const e = this.electron;
    if (!e?.BrowserWindow || !e.screen) return;
    let displays = [];
    try {
      displays = e.screen.getAllDisplays();
    } catch (error) {
      // no screen info: show no overlay (the overlay is cosmetic; Esc still stops)
      noteIgnored('list the displays for the control indicator', error);
    }
    // one window per display, reused across shows
    while (this.windows.length > displays.length) {
      const w = this.windows.pop();
      this.loaded.delete(w);
      this.shown.delete(w);
      this.flights.delete(w);
      try {
        w.destroy();
      } catch (error) {
        // the window may already be destroyed
        noteIgnored('close the control indicator on a removed display', error);
      }
    }
    displays.forEach((d, i) => {
      let w = this.windows[i];
      if (!w || w.isDestroyed?.()) {
        if (w) {
          this.loaded.delete(w);
          this.shown.delete(w);
          this.flights.delete(w);
        }
        try {
          w = this.windows[i] = this.#makeWindow(e);
        } catch {
          return;
        }
      }
      try {
        w.setBounds(d.bounds);
        w.showInactive();
      } catch (error) {
        // the overlay is cosmetic; a destroyed window is skipped
        noteIgnored('show the control indicator overlay', error);
        return;
      }
      this.#reveal(w, gen).catch(ignoring('fade in the control indicator overlay'));
    });
  }

  /**
   * Fades `w` in once its page has loaded. Shown while still showing (control passed to another chat), the new
   * sheet goes in before the old one comes out, so the overlay stays up and the badge flies again.
   */
  async #reveal(w, gen) {
    await this.loaded.get(w);
    if (gen !== this.generation || w.isDestroyed?.()) return;
    const n = (this.flights.get(w) ?? 0) + 1;
    this.flights.set(w, n);
    const key = await w.webContents.insertCSS(shownCss(n, !!this.pills, this.labelFor(this.chatId)));
    const keys = this.shown.get(w) ?? [];
    this.shown.set(w, keys);
    keys.push(key);
    // hidden while the sheet went in: every sheet comes out; else only the older ones
    const drop = gen === this.generation ? keys.slice(0, -1) : keys.slice();
    for (const k of drop) {
      await w.webContents.removeInsertedCSS(k);
      forget(keys, k);
    }
  }

  #hideOverlay() {
    this.generation++;
    for (const [w, keys] of this.shown) {
      if (w.isDestroyed?.()) continue;
      // a sheet that fails to come out stays listed, for the next show or hide to take out
      for (const key of keys.slice()) {
        w.webContents.removeInsertedCSS(key).then(() => forget(keys, key), ignoring('fade out the control indicator overlay'));
      }
    }
    this.#cancelHide();
    // a show before it fires cancels it
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      for (const w of this.windows) {
        try {
          if (!w.isDestroyed?.()) w.hide();
        } catch (error) {
          // the window may already be destroyed
          noteIgnored('hide the control indicator overlay', error);
        }
      }
    }, this.fadeMs);
  }

  /** @param {{ BrowserWindow: any }} e Electron's modules, when the indicator has them */
  #makeWindow(e) {
    const w = new e.BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      title: 'MoPilot control indicator',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false },
    });
    w.setIgnoreMouseEvents(true);
    // the screen-saver level: above apps and full-screen windows (and what the helper's hit test looks through)
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    // never in a screenshot or a screen share
    w.setContentProtection(true);
    this.loaded.set(
      w,
      w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(this.label))}`).catch((error) => {
        // the overlay is cosmetic; a failed load leaves it blank
        noteIgnored('load the control indicator overlay', error);
      }),
    );
    return w;
  }
}

module.exports = { ControlIndicator, overlayHtml, shownCss, labelCss, escapeStops, LABEL, FADE_MS, ESCAPE_ASK_MS, ESCAPE_SETTLE_MS };
