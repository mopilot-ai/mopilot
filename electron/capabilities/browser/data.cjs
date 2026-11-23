// What the built-in browser remembers besides cookies, as one service for main: the history and bookmark stores (opened on first use), the address bar's suggestions and the recorder that feeds history.
const path = require('node:path');
const { HistoryStore } = require('./historyStore.cjs');
const { BookmarkStore } = require('./bookmarkStore.cjs');
const { attachHistory } = require('./historyRecorder.cjs');
const { suggest } = require('./suggest.cjs');

/**
 * @param {{ userData: () => string, now?: () => number, safeStorage?: import('../../platform/secretFile.cjs').SafeStorage | null }} o
 *   userData: the app's user data folder (read when a store first opens)
 *   safeStorage: what the history is encrypted with (historyStore.cjs)
 */
function createBrowserData({ userData, now = Date.now, safeStorage = null }) {
  /** @type {InstanceType<typeof HistoryStore> | null} */
  let history = null;
  /** @type {InstanceType<typeof BookmarkStore> | null} */
  let bookmarks = null;
  const data = {
    history: () => (history ??= new HistoryStore({ file: path.join(userData(), 'browser-history.sqlite'), now, safeStorage })),
    bookmarks: () => (bookmarks ??= new BookmarkStore({ file: path.join(userData(), 'browser-bookmarks.json'), now })),
    /** Suggestions for typed text: bookmarks first, then visited pages. */
    suggest: (text, limit) => suggest({ bookmarks: data.bookmarks(), history: data.history() }, text, limit),
    /** Starts recording a tab's visits (the shared profile only). */
    attach: (wc, isShared) => attachHistory(wc, { history: data.history, isShared }),
    /** Clear browsing data: history goes; bookmarks stay. */
    clearHistory: () => data.history().clear(),
    /** The app is quitting: what the history has not saved yet is saved (sealed). */
    close: () => history?.close(),
  };
  return data;
}

module.exports = { createBrowserData };
