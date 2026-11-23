// App zoom in main: the saved zoom level (prefs.zoomLevel, shared/zoom.mjs) on every app window's page, with the window chrome placed for it.
const { normalizeZoomLevel, titleBarHeightAt, windowButtonsAt, zoomFactorOf, zoomLevelOf } = require('../../shared/zoom.mjs');

/** macOS's window buttons at Actual Size (electron/app/windows.cjs titleBarStyle 'hiddenInset'). */
const WINDOW_BUTTONS = { x: 17, y: 16 };
/** The title bar's height in CSS pixels (src/styles/tokens.css --titlebar-h): Windows' caption buttons match it. */
const TITLE_BAR_HEIGHT = 44;

/**
 * @typedef {'buttons' | 'overlay' | null} ZoomChrome what the window draws in its title bar: macOS's window buttons,
 *   Windows' caption buttons, or none (Quick Chat)
 * @param {{ prefs: () => unknown }} opts the saved prefs (ui-state.json), read once when the first window opens (after the
 *   profile folder is set): their level, or the one an old font size asks for (shared/zoom.mjs zoomLevelOf)
 */
function createZoom({ prefs }) {
  /** @type {number | null} */
  let level = null;
  const current = () => (level ??= zoomLevelOf(prefs()));
  /** @type {Map<Electron.BrowserWindow, ZoomChrome>} */
  const windows = new Map();
  const factor = () => zoomFactorOf(current());

  /** The window's page at the current level, and its title bar buttons placed for it. */
  function fit(win, chrome) {
    if (win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc.getZoomLevel() !== current()) wc.setZoomLevel(current());
    if (chrome === 'buttons') win.setWindowButtonPosition(windowButtonsAt(WINDOW_BUTTONS, factor()));
    else if (chrome === 'overlay') win.setTitleBarOverlay({ height: titleBarHeightAt(TITLE_BAR_HEIGHT, factor()) });
  }

  return {
    get level() {
      return current();
    },
    /** The title bar options a new window starts with, at the current level. */
    chromeOptions() {
      return {
        trafficLightPosition: windowButtonsAt(WINDOW_BUTTONS, factor()),
        titleBarHeight: titleBarHeightAt(TITLE_BAR_HEIGHT, factor()),
      };
    },
    /** The caption buttons' height for a window at its own zoom factor (window:titleBarOverlay). */
    titleBarHeight: (/** @type {number} */ zoomFactor) => titleBarHeightAt(TITLE_BAR_HEIGHT, zoomFactor),
    /**
     * A new app window follows the level from its first page on: Chromium keeps a zoom level per page address, so a
     * load, a reload or a route change can come back at another level; each puts this one back.
     * @param {Electron.BrowserWindow} win
     * @param {ZoomChrome} chrome
     */
    attach(win, chrome) {
      windows.set(win, chrome);
      const refit = () => fit(win, chrome);
      win.webContents.on('did-navigate', refit);
      win.webContents.on('did-navigate-in-page', refit);
      win.once('closed', () => windows.delete(win));
    },
    /** A new saved level (prefs.zoomLevel from any window or main) goes to every window now. False when it is the same. */
    set(next) {
      const n = normalizeZoomLevel(next);
      if (n === current()) return false;
      level = n;
      for (const [win, chrome] of windows) fit(win, chrome);
      return true;
    },
  };
}

module.exports = { createZoom, WINDOW_BUTTONS, TITLE_BAR_HEIGHT };
