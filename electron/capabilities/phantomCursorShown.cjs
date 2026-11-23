// What the phantom cursor's window shows: whether its committed page is the approach's own (the page carries a per-approach nonce in its URL), and the note for a page that never carried it.
const { noteIgnored } = require('../ignored.cjs');

/** The cap fired with a readable page that never carried the start marker: every click would wait the cap, so say so (a short URL head only). */
function noteUnshown(w, nonce) {
  try {
    const url = w.webContents.getURL?.();
    if (typeof url === 'string' && !url.includes(nonce)) {
      noteIgnored('phantom cursor: the overlay page never showed its start marker', new Error(url.slice(0, 60)));
    }
  } catch (error) {
    // an unreadable page is the fallback case (the start goes on); only the read failure is recorded
    noteIgnored('read the phantom cursor page address', error);
  }
}

/** Whether the window's committed page is the one carrying `nonce` (true when the page's URL cannot be read). */
function isShowing(w, nonce) {
  try {
    const url = w.webContents.getURL?.();
    return typeof url !== 'string' || url.includes(nonce);
  } catch {
    return true;
  }
}

module.exports = { noteUnshown, isShowing };
