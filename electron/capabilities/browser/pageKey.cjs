// The key state about a page is kept under, so a wrapped Electron page and its webContents are one page (backend.cjs).

/**
 * The identity state about a page is keyed by (downloads, view tabs, layers): the native object behind a wrapped
 * Electron page, so the wrapper and the webContents the session's events name are one key; a backend that is its own
 * page is its own key.
 * @param {any} contents a backend or an Electron webContents
 */
function keyOf(contents) {
  return contents?.identity ?? contents;
}

module.exports = { keyOf };
