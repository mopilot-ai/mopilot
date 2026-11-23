// The browser backend contract: what a browser host tab (tab.cjs) needs from the page it drives, and the registry of backend-owned tabs.
//
// A backend is whatever holds the page: Electron's WebContentsView in this app (localBackend.cjs), the user's Chrome over
// the relay (chromeTab.cjs), or a headless Chromium on a remote Host. The tool layer talks CDP to it and asks it for state.
// Members (webContents-shaped, as ChromeTabContents already is):
// - debugger: isAttached(), attach(version), detach(), sendCommand(method, params, sessionId), on/removeListener('message' | 'detach')
// - getURL(), getTitle(), isLoading(), isDestroyed(), isCrashed()
// - on/once/off for did-start-loading, did-stop-loading, did-navigate, did-navigate-in-page, did-fail-load, destroyed
// - navigationHistory (getAllEntries, getActiveIndex, goToIndex...), setBackgroundThrottling(allowed)
// - identity (optional): the object the page's state is keyed by when the backend wraps one (see keyOf)
// - capture(rect?): an image of the page, or a rejection / empty image to fall back to CDP Page.captureScreenshot (optional)
// - assertDrivable(): throws a ToolError saying why the page can't be driven now (optional)
// assertCdpTarget (cdp.cjs) lets a backend-owned tab through by `isBackendTab`, then its own `assertDrivable`.

const { isFailedLoad } = require('./downloadNavigations.cjs');
const { keyOf } = require('./pageKey.cjs');

/** Every backend-owned tab contents that is not an Electron webContents: relay tabs, remote tabs, test fakes. */
const BACKEND_TABS = new WeakSet();

/**
 * Registers `contents` as backend-owned and returns it, so assertCdpTarget accepts it.
 * @template T
 * @param {T} contents
 * @returns {T}
 */
function markBackendTab(contents) {
  BACKEND_TABS.add(/** @type {object} */ (contents));
  return contents;
}

/** Whether `contents` is a backend-owned tab (not an Electron webContents). */
function isBackendTab(contents) {
  return !!contents && typeof contents === 'object' && BACKEND_TABS.has(contents);
}

/**
 * Takes an image of the page, preferring the backend's own `capture` and otherwise Electron's `capturePage`.
 * Resolves to null when the backend has nothing to capture (the caller falls back to CDP).
 * @param {any} contents
 * @param {{ x: number, y: number, width: number, height: number } | undefined} rect in DIPs
 */
function captureContents(contents, rect) {
  if (typeof contents.capture === 'function') return contents.capture(rect);
  if (typeof contents.capturePage === 'function') return contents.capturePage(rect);
  return Promise.resolve(null);
}

/** Follows a tab's page loads: a new load clears the failure, a failed one records it, a navigation tells the pane. */
function watchLoads(tab, contents) {
  contents.on('did-start-loading', () => {
    tab.failure = null;
  });
  // the pane shows the site and its permission: say when the page changes
  contents.on('did-navigate', () => tab.host.emit?.(tab.chatId));
  contents.on('did-navigate-in-page', () => tab.host.emit?.(tab.chatId));
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (isFailedLoad(contents, code, url, mainFrame)) tab.failure = description || String(code);
  });
}

module.exports = { keyOf, markBackendTab, isBackendTab, captureContents, watchLoads };
