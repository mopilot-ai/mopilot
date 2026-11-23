// Makes Mobile Remote's always-on controller from Electron's pieces and tells every window when its state changes (the controller itself is electron/app/alwaysOn.cjs).
const { createAlwaysOn } = require('./alwaysOn.cjs');
const { phoneAccess, phoneAccessAtStart } = require('../remote/phoneAccess.cjs');
const electronWindows = require('../platform/electronWindows.cjs');

/**
 * @param {object} o
 * @param {Electron.App} o.app
 * @param {(what: string, error: unknown) => void} o.ignored main's reporter for a swallowed failure
 * @param {Pick<typeof Electron, 'BrowserWindow' | 'powerSaveBlocker' | 'powerMonitor'>} [o.electron] replaced in tests
 * @param {{ refreshTray: () => void }} o.menus
 * @param {any} o.live
 * @param {(channel: string, ...args: unknown[]) => void} o.broadcastAll
 */
function openAlwaysOn({ app, menus, live, broadcastAll, ignored, electron = electronWindows }) {
  const alwaysOn = createAlwaysOn({
    app,
    BrowserWindow: electron.BrowserWindow,
    powerSaveBlocker: electron.powerSaveBlocker ?? null,
    powerMonitor: electron.powerMonitor ?? null,
    userData: app.getPath('userData'),
    live,
    ignored,
    refreshTray: () => menus.refreshTray(),
    // the quiet login start runs before the account is read: it follows the cached answer until the gate is open
    flagOn: () => phoneAccess() || phoneAccessAtStart(app.getPath('userData')),
    onChange: (state) => broadcastAll('alwaysOn:changed', state),
  });
  alwaysOn.watchWindows();
  return alwaysOn;
}

/**
 * Opens the app's first window unless the login item started it for Mobile Remote (the menu-bar item is the app then).
 * @param {{ startsQuietly(): boolean }} alwaysOn
 * @param {() => void} openWindow
 * @returns {boolean} whether the start is quiet
 */
function openStartupWindow(alwaysOn, openWindow) {
  const quiet = alwaysOn.startsQuietly();
  if (!quiet) openWindow();
  return quiet;
}

/**
 * Starts Mobile Remote and lets always-on follow it. A quiet start whose menu-bar item did not come up (the remote runtime
 * failed, say) opens the window: nothing else would tell the user the app is running.
 * @param {{ live: any, quiet: boolean, showMainWindow: () => unknown }} o
 */
async function startRemote({ live, quiet, showMainWindow }) {
  await live.remote.sync();
  live.alwaysOn.sync();
  if (quiet && !live.alwaysOn.active) showMainWindow();
}

module.exports = { openAlwaysOn, openStartupWindow, startRemote };
