// The recording pill (Record a skill): while a demonstration is recorded, a small always-on-top capsule at the top of the screen,
// "Recording · 0:12" with Done and Discard, and "30 s left" near the limit. Like the control pill (controlPill.cjs) the page has no
// script of its own: Done and Discard are links main takes as clicks (will-navigate), and main updates the clock by evaluating a
// line in the page. The window opts out of capture, so it never appears in a screenshot.

const DONE_URL = 'https://record.mopilot.invalid/done';
const DISCARD_URL = 'https://record.mopilot.invalid/discard';
const SIZE = { width: 330, height: 44 };
/** How far below the top of the display's work area. */
const INSET = 12;

function pillHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>MoPilot recording</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
#pill{box-sizing:border-box;position:fixed;inset:2px;display:flex;align-items:center;gap:8px;background:rgba(38,37,34,.94);border:.5px solid rgba(255,255,255,.12);border-radius:999px;padding:0 5px 0 14px;font:500 13px -apple-system,BlinkMacSystemFont,sans-serif;color:rgba(255,255,255,.92);white-space:nowrap}
#dot{flex:none;width:8px;height:8px;border-radius:50%;background:#ff5f57;animation:blink 1.4s ease-in-out infinite}
#label{flex:1;overflow:hidden;text-overflow:ellipsis}
#t{font-variant-numeric:tabular-nums;color:rgba(255,255,255,.6);font-weight:400}
#warn{color:#f0b8a3;font-weight:400}
a{flex:none;padding:4px 12px;border-radius:999px;border:.5px solid rgba(255,255,255,.18);color:rgba(255,255,255,.92);text-decoration:none;cursor:pointer}
a:hover{background:rgba(255,255,255,.1)}
a#done{background:rgba(255,255,255,.92);color:#1c1b19;border-color:transparent}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
@media (prefers-reduced-motion:reduce){#dot{animation:none}}
</style></head><body><div id="pill"><div id="dot"></div><div id="label">Recording <span id="t">0:00</span> <span id="warn"></span></div><a id="discard" href="${DISCARD_URL}" draggable="false">Discard</a><a id="done" href="${DONE_URL}" draggable="false">Done</a></div></body></html>`;
}

/** The line that sets the clock and the warning in the page. */
function updateScript(clock, warning) {
  return `document.getElementById("t").textContent=${JSON.stringify(clock)};document.getElementById("warn").textContent=${JSON.stringify(warning)}`;
}

class RecordPill {
  /**
   * @param {object} o
   * @param {{ BrowserWindow: any, screen: any } | null} o.electron Electron's main-process modules
   * @param {() => void} o.onDone the person clicked Done
   * @param {() => void} o.onDiscard the person clicked Discard
   * @param {(what: string, error: unknown) => void} o.note where an error that is survived is noted
   */
  constructor(o) {
    this.electron = o.electron || null;
    this.onDone = o.onDone;
    this.onDiscard = o.onDiscard;
    this.note = o.note;
    /** @type {any} */
    this.window = null;
    this.up = false;
  }

  /** Whether this process can draw the pill at all. */
  get available() {
    return !!(this.electron?.BrowserWindow && this.electron?.screen);
  }

  show() {
    const e = /** @type {NonNullable<RecordPill['electron']>} */ (this.electron);
    this.up = true;
    try {
      const w = this.window && !this.window.isDestroyed?.() ? this.window : (this.window = this.#makeWindow(e));
      const area = e.screen.getPrimaryDisplay().workArea;
      w.setBounds({ x: Math.round(area.x + (area.width - SIZE.width) / 2), y: Math.round(area.y + INSET), ...SIZE });
      w.showInactive();
    } catch (error) {
      // the pill is how a person ends the recording: without it the recording cannot start
      this.up = false;
      throw error;
    }
  }

  /** The clock and the warning ("30 s left", or none). */
  update(clock, warning = '') {
    const w = this.window;
    if (!this.up || !w || w.isDestroyed?.()) return;
    w.webContents.executeJavaScript(updateScript(clock, warning)).catch((error) => this.note('update the recording pill', error));
  }

  hide() {
    this.up = false;
    try {
      if (this.window && !this.window.isDestroyed?.()) this.window.hide();
    } catch (error) {
      // the window may already be destroyed
      this.note('hide the recording pill', error);
    }
  }

  dispose() {
    this.up = false;
    try {
      this.window?.destroy();
    } catch (error) {
      // the window may already be destroyed
      this.note('close the recording pill', error);
    }
    this.window = null;
  }

  #makeWindow(e) {
    const w = new e.BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: false,
      acceptFirstMouse: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'MoPilot recording',
      // script is on only so main can set the clock; the page's CSP allows none of its own
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    w.setContentProtection(true);
    w.webContents.on('will-navigate', (/** @type {{ preventDefault(): void }} */ event, /** @type {string} */ url) => {
      event.preventDefault();
      if (!this.up) return;
      if (url === DONE_URL) this.onDone();
      else if (url === DISCARD_URL) this.onDiscard();
    });
    w.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillHtml())}`).catch((error) =>
      this.note('load the recording pill', error),
    );
    return w;
  }
}

module.exports = { RecordPill, pillHtml, updateScript, DONE_URL, DISCARD_URL, SIZE };
