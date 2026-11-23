// While a chat holds the screen, MoPilot's window docks as a small always-on-top panel in the top-right corner (as Claude Desktop's does) instead of hiding, so approval cards stay answerable; it goes back to its place when control ends.

const { noteIgnored } = require('../ignored.cjs');

/** The docked panel's size and its margin from the screen's edge (Claude Desktop's 520 x 720 corner panel). */
const PANEL = { width: 520, height: 720, margin: 12 };

/**
 * The panel's place in a display's work area (below the menu bar, beside the Dock): its top-right corner.
 * @param {{ x: number, y: number, width: number, height: number }} area
 */
function panelBounds(area) {
  const width = Math.min(PANEL.width, area.width - 2 * PANEL.margin);
  const height = Math.min(PANEL.height, area.height - 2 * PANEL.margin);
  return { x: area.x + area.width - width - PANEL.margin, y: area.y + PANEL.margin, width, height };
}

/**
 * Docks `w` as the corner panel, showing the chat in control without taking the keyboard: above other windows, on
 * every Space and over full-screen apps, and kept out of screenshots. Returns what undock() needs to put it back.
 * @param {any} electron
 * @param {any} w
 * @param {string | null} chatId the chat holding the screen, opened in the panel
 */
function dock(electron, w, chatId) {
  const saved = {
    w,
    bounds: w.getBounds(),
    onTop: w.isAlwaysOnTop(),
    protected: typeof w.isContentProtected === 'function' ? w.isContentProtected() : false,
    // the app window's minimum size (760 wide) would keep it wider than the panel
    min: typeof w.getMinimumSize === 'function' ? w.getMinimumSize() : null,
  };
  if (saved.min) w.setMinimumSize(PANEL.width - 2 * PANEL.margin, 320);
  const area = electron.screen?.getDisplayMatching?.(saved.bounds)?.workArea;
  if (area) w.setBounds(panelBounds(area));
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setContentProtection(true);
  // the page shows the chat alone while docked (src/lib/docked.ts), on the chat in control
  w.webContents?.send?.('app:command', 'docked', true);
  if (chatId) w.webContents?.send?.('app:command', 'open-chat', chatId);
  w.showInactive();
  return saved;
}

/** Puts a docked window back where and how it was. */
function undock(saved) {
  const { w } = saved;
  if (w.isDestroyed()) return;
  try {
    w.setVisibleOnAllWorkspaces(false);
    w.setAlwaysOnTop(saved.onTop);
    w.setContentProtection(saved.protected);
    if (saved.min) w.setMinimumSize(saved.min[0], saved.min[1]);
    w.webContents?.send?.('app:command', 'docked', false);
    w.setBounds(saved.bounds);
  } catch (error) {
    // the window may be closing; it opens at its own place next time
    noteIgnored('put the docked MoPilot window back', error);
  }
}

module.exports = { dock, undock, panelBounds, PANEL };
