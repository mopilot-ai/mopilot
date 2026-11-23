// The local browser backend: an Electron WebContentsView's webContents behind the backend contract (backend.cjs).
/**
 * Wraps a pane tab's webContents. Members read through to it, so a destroyed page and test fakes behave as the page does;
 * `contents` is the Electron object itself, for the layers that are about Electron windows (views.cjs, pageDialogs.cjs).
 */
class LocalTabContents {
  /** @param {any} contents an Electron webContents */
  constructor(contents) {
    this.contents = contents;
  }

  /** The webContents, which the session's events (downloads, popups) name: the key state about this page is kept under. */
  get identity() {
    return this.contents;
  }

  get id() {
    return this.contents.id;
  }

  get debugger() {
    return this.contents.debugger;
  }

  get navigationHistory() {
    return this.contents.navigationHistory;
  }

  on(event, listener) {
    this.contents.on(event, listener);
    return this;
  }

  once(event, listener) {
    this.contents.once(event, listener);
    return this;
  }

  off(event, listener) {
    this.contents.off(event, listener);
    return this;
  }

  removeListener(event, listener) {
    this.contents.removeListener(event, listener);
    return this;
  }

  emit(event, ...args) {
    return this.contents.emit(event, ...args);
  }

  isLoadingMainFrame() {
    return this.contents.isLoadingMainFrame();
  }

  isCrashed() {
    return this.contents.isCrashed?.() === true;
  }

  reload() {
    this.contents.reload();
  }

  stop() {
    this.contents.stop();
  }

  getUserAgent() {
    return this.contents.getUserAgent();
  }

  getZoomFactor() {
    return this.contents.getZoomFactor?.();
  }

  isDestroyed() {
    return this.contents.isDestroyed();
  }

  getURL() {
    return this.contents.getURL();
  }

  getTitle() {
    return this.contents.getTitle();
  }

  isLoading() {
    return this.contents.isLoading();
  }

  setBackgroundThrottling(allowed) {
    this.contents.setBackgroundThrottling(allowed);
  }

  /** An image of the page (a region in DIPs), as capturePage gives it. */
  capture(rect) {
    return this.contents.capturePage(rect);
  }
}

module.exports = { LocalTabContents };
