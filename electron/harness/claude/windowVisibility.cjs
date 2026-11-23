// Whether any app window is on screen (shown and not minimized): background work that only a visible window can use checks it before asking for more.

/** Electron's BrowserWindow, or undefined where Electron isn't there (tests, scripts). */
function electronWindows(load = require) {
  try {
    return load('electron').BrowserWindow;
  } catch {
    return undefined;
  }
}

/** @param {{ getAllWindows?: () => Array<{ isDestroyed: () => boolean, isVisible: () => boolean, isMinimized: () => boolean }> } | undefined} [browserWindow] */
function anyWindowVisible(browserWindow = electronWindows()) {
  // no window system to wait for: counts as visible
  if (!browserWindow?.getAllWindows) return true;
  return browserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized());
}

module.exports = { anyWindowVisible, electronWindows };
