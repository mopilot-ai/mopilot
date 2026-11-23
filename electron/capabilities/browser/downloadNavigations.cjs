// Which page's navigation turned into a download, so that navigation is never reported as a failed load (#1484).
//
// A link answered with Content-Disposition: attachment (an export, a mail attachment) starts a download and ends the
// page's navigation: Chromium reports that navigation as failed (ERR_ABORTED, or ERR_BLOCKED_BY_CLIENT when the
// download was then cancelled), and the pane's failure notice and its Retry would load the same URL again, a dead
// end. The session's will-download notes the page and the URLs it downloaded from; the failure handlers ask here, and
// so does an agent's navigate (becameDownload), which tells the agent a download started instead of a failure.

const { keyOf } = require('./pageKey.cjs');

/** How long after a download starts its page's navigation failure still counts as that download. */
const WINDOW_MS = 10_000;
/** How long an aborted navigation waits for its download: the session's will-download can come just after the abort. */
const ABORT_WAIT_MS = 2000;
/** @type {WeakMap<object, { urls: Set<string>, at: number }>} a page's webContents -> its last download */
const recent = new WeakMap();
/** @type {WeakMap<object, Set<{ url: unknown, done: (v: boolean) => void }>>} navigations waiting to hear of a download */
const waiting = new WeakMap();

/** The same address, however it was written ("http://a.test" and Chromium's "http://a.test/"). */
const sameUrl = (/** @type {unknown} */ a, /** @type {unknown} */ b) => {
  try {
    return new URL(String(a)).href === new URL(String(b)).href;
  } catch {
    return String(a) === String(b);
  }
};

/**
 * A page started a download from `urls` (the download's URL chain: a redirect to the file included).
 * @param {object | null | undefined} wc @param {unknown[]} urls
 */
function noteDownload(wc, urls, now = Date.now()) {
  if (!wc) return;
  const set = new Set(urls.filter((u) => typeof u === 'string' && u).map(String));
  if (!set.size) return;
  const key = keyOf(wc);
  recent.set(key, { urls: set, at: now });
  for (const w of [...(waiting.get(key) ?? [])]) if ([...set].some((u) => sameUrl(u, w.url))) w.done(true);
}

/** Whether `url`'s navigation on this page just turned into a download. @param {object | null | undefined} wc @param {unknown} url */
function wasDownload(wc, url, now = Date.now()) {
  const r = wc ? recent.get(keyOf(wc)) : undefined;
  return !!r && now - r.at < WINDOW_MS && [...r.urls].some((u) => sameUrl(u, url));
}

/**
 * Whether a navigation to `url` that Chromium answered with `errorText` turned into a download: an abort noted already,
 * or, for ERR_ABORTED, noted within `ms`. Any other error is a failed load at once, whatever the page downloaded before.
 * @param {object | null | undefined} wc @param {unknown} url @param {unknown} errorText
 * @returns {Promise<boolean>}
 */
function becameDownload(wc, url, errorText, ms = ABORT_WAIT_MS) {
  // a download ends its page's navigation with an abort (ERR_ABORTED), or ERR_BLOCKED_BY_CLIENT once it is cancelled
  if (!wc || !/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(String(errorText))) return Promise.resolve(false);
  if (wasDownload(wc, url)) return Promise.resolve(true);
  if (!String(errorText).includes('ERR_ABORTED')) return Promise.resolve(false);
  return new Promise((resolve) => {
    const key = keyOf(wc);
    let set = waiting.get(key);
    if (!set) waiting.set(key, (set = new Set()));
    const mine = set;
    const w = {
      url,
      done: (/** @type {boolean} */ v) => {
        clearTimeout(timer);
        mine.delete(w);
        resolve(v);
      },
    };
    const timer = setTimeout(() => w.done(false), ms);
    set.add(w);
  });
}

/** What an agent's navigate says when the link downloaded a file instead of opening a page. */
const DOWNLOAD_NOTE = 'The link started a download instead of opening a page. Where the file lands comes in a later result (download_).';

/**
 * Whether a did-fail-load is a page's failed load: its main frame, not a cancelled navigation (ERR_ABORTED, Stop
 * included), and not a navigation that turned into a download. Every handler of the event asks this one rule.
 * @param {object | null | undefined} wc @param {number} code @param {unknown} url @param {boolean} mainFrame
 */
const isFailedLoad = (wc, code, url, mainFrame, now = Date.now()) => !!mainFrame && code !== -3 && !wasDownload(wc, url, now);

module.exports = { noteDownload, wasDownload, becameDownload, isFailedLoad, WINDOW_MS, ABORT_WAIT_MS, DOWNLOAD_NOTE };
