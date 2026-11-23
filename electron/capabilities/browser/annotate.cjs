// Browser pane Annotate mode (IAB-06), main's half, for every harness:
// - The overlay (src/lib/annotateOverlay.ts) runs in an isolated world of the pane tab (IAB-13): its
//   state and what it collects are out of reach of the page's own scripts. The pane cannot reach an
//   isolated world from its <webview>, so it asks main (browser:annotate).
// - The pane asks main for a screenshot of a region of the tab, with the numbered marks the overlay
//   drew. The image goes into the composer as an ordinary image attachment, so every harness
//   receives it.
// Both act only on a pane tab in one of the pane's sessions (the shared profile or a chat's own
// partition, storage.cjs): a view main created (views.cjs), which any app window may show, or a
// <webview> guest hosted by the asking window.
const { noteIgnored } = require('../../ignored.cjs');
const { isViewTab } = require('./views.cjs');

const CAPTURE_MS = 5000;
/** Largest side accepted, in DIPs. */
const MAX_SIDE = 16384;
/**
 * The isolated world the overlay runs in. Electron reserves 0 (the page's world) and 999 (preload
 * context isolation); pageAgent's CDP world is created by name, not by this id.
 */
const ANNOTATE_WORLD = 1206;
/** Largest overlay script accepted, in characters. */
const MAX_SCRIPT = 100_000;

/** The rect as whole DIPs with a positive size, or null. */
function captureRect(rect) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);
  const r = {
    x: Math.max(0, n(rect?.x)),
    y: Math.max(0, n(rect?.y)),
    width: Math.min(MAX_SIDE, n(rect?.width)),
    height: Math.min(MAX_SIDE, n(rect?.height)),
  };
  return Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0 ? r : null;
}

/** Whether `wc` is a live pane tab (a view, or a guest of the window `sender`) in one of the pane's sessions (one or a list). */
function isPaneTab(wc, { sender, panelSession }) {
  const sessions = Array.isArray(panelSession) ? panelSession : [panelSession];
  if (!wc || wc.isDestroyed() || !sessions.includes(wc.session)) return false;
  return isViewTab(wc) || (wc.getType() === 'webview' && wc.hostWebContents === sender);
}

/**
 * A PNG data URL of `rect` on the pane tab `wc`, or null. Only a pane tab of the asking window is
 * captured, and only when it paints within `timeoutMs`.
 */
async function captureRegion(wc, rect, { sender, panelSession, timeoutMs = CAPTURE_MS }) {
  const r = captureRect(rect);
  if (!r || !isPaneTab(wc, { sender, panelSession })) return null;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs, null);
  });
  // null tells the window the capture failed (it says so); why it failed is recorded
  const image = await Promise.race([Promise.resolve().then(() => wc.capturePage(r)), timeout]).catch((error) => {
    noteIgnored('capture the annotated region of a pane tab', error);
    return null;
  });
  clearTimeout(timer);
  return image && !image.isEmpty() ? image.toDataURL() : null;
}

/**
 * Runs an overlay script in the Annotate world of the pane tab `wc` and resolves with its value (a
 * promise's result). Rejects for anything that is not a pane tab of the asking window, and for a
 * script that is not a string of at most MAX_SCRIPT characters. Never runs in the page's own world.
 */
async function runOverlay(wc, code, { sender, panelSession }) {
  if (typeof code !== 'string' || !code || code.length > MAX_SCRIPT) throw new Error('Not an Annotate script.');
  if (!isPaneTab(wc, { sender, panelSession })) throw new Error('Not a browser pane tab of this window.');
  return wc.executeJavaScriptInIsolatedWorld(ANNOTATE_WORLD, [{ code }]);
}

/**
 * `browser:captureRegion` (webContentsId, rect) and `browser:annotate` (webContentsId, script): the
 * window's own pane tab, looked up by id.
 * @param {object} o
 * @param o.webContents Electron's webContents module
 * @param o.panelSession () => the pane's session, or every session a pane tab may be in
 */
function registerCapture(ipcMain, { webContents, panelSession }) {
  const tabOf = (id) => {
    try {
      return webContents.fromId(id);
    } catch {
      return null; /* not a webContents id */
    }
  };
  ipcMain.handle('browser:captureRegion', (e, id, rect) =>
    captureRegion(tabOf(id), rect, { sender: e.sender, panelSession: panelSession() }),
  );
  ipcMain.handle('browser:annotate', (e, id, code) => runOverlay(tabOf(id), code, { sender: e.sender, panelSession: panelSession() }));
}

module.exports = { captureRegion, captureRect, isPaneTab, runOverlay, registerCapture, CAPTURE_MS, MAX_SIDE, ANNOTATE_WORLD, MAX_SCRIPT };
