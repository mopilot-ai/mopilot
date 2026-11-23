// Records the pages a browser tab visits in the shared profile into the history store (every harness, user and agent tabs alike); a chat's own in-memory partition is never recorded, as a private window is not.
const { noteIgnored } = require('../../ignored.cjs');

/**
 * @param {import('electron').WebContents} wc a browser tab's page (a pane view, a popup or a legacy guest)
 * @param {{ history: () => { record(o: { url: string }): boolean, setTitle(url: string, title: string): void }, isShared: (wc: any) => boolean }} o
 *   history: the store, opened on first use
 *   isShared: whether the page is in the shared persistent profile
 */
function attachHistory(wc, { history, isShared }) {
  wc.on('did-navigate', (_event, url, httpResponseCode) => {
    // an error page is not somewhere to go back to
    if (typeof httpResponseCode === 'number' && httpResponseCode >= 400) return;
    try {
      if (isShared(wc)) history().record({ url });
    } catch (error) {
      noteIgnored('record a visited page in the browser history', error);
    }
  });
  wc.on('page-title-updated', (_event, title) => {
    try {
      if (isShared(wc)) history().setTitle(wc.getURL(), title);
    } catch (error) {
      noteIgnored('record a page title in the browser history', error);
    }
  });
}

module.exports = { attachHistory };
