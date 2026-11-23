// A tab's back/forward history copied into a new page (Duplicate, the user's and the agent's): read and checked from the source, written into a page that has loaded nothing yet, settled once the entries are that page's history.
//
// Electron's navigationHistory.restore() writes the entries at once, but its promise settles only when the
// current entry's page finishes loading (did-finish-load) or fails (did-fail-load, which a Stop also fires).
// A copy waits for neither: a slow, stopped or failed load is the new page's own state, as on any tab, and
// never undoes the copy (#1362). Electron attaches a no-op rejection handler to that promise.
const { isWebUrl } = require('../../../shared/browser.mjs');

const webUrl = (url) => url === 'about:blank' || isWebUrl(url);

/**
 * The page's history as a copy ({ entries, index }), or null when it has none usable yet: no entries, an index
 * out of range, or an entry that is not a web page.
 * @param {Electron.WebContents} wc
 * @returns {{ entries: Electron.NavigationEntry[], index: number } | null}
 */
function readHistory(wc) {
  const history = wc.navigationHistory;
  const entries = history.getAllEntries();
  const index = history.getActiveIndex();
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= entries.length ||
    entries.some((entry) => !entry || typeof entry.title !== 'string' || !webUrl(entry.url))
  )
    return null;
  return { entries: entries.map((entry) => ({ ...entry })), index };
}

/** Whether `copy` is `wc`'s history now. */
function holdsHistory(wc, { entries, index }) {
  const history = wc.navigationHistory;
  return (
    history.length() === entries.length &&
    history.getActiveIndex() === index &&
    entries.every((entry, i) => history.getEntryAtIndex(i)?.url === entry.url)
  );
}

/**
 * Writes `copy` into `wc`, a page that has loaded nothing yet (Electron refuses one that has, about:blank
 * included). Resolves once the entries are the page's history; rejects with Electron's reason when they are not.
 * @param {Electron.WebContents} wc
 * @param {{ entries: Electron.NavigationEntry[], index: number }} copy
 */
async function restoreHistory(wc, copy) {
  const loading = wc.navigationHistory.restore({ entries: copy.entries, index: copy.index });
  // from here the current entry's load is the page's own: the pane shows its progress, Stop and failure
  if (holdsHistory(wc, copy)) return;
  await loading;
  throw new Error('The history could not be copied to the new tab.');
}

module.exports = { readHistory, restoreHistory, holdsHistory };
