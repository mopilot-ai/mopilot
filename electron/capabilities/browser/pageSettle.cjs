// When a browser page has settled after an action, for every browser route (#1651): the browser_* tools and browser_script
// on the built-in browser and on the user's Chrome (the same BrowserTabs), and sage_browser_*. Event-based: an idle page
// returns once its DOM has been quiet for a short window, not after a fixed floor.
//
// Settled means all of:
// - no load is in progress (webContents.isLoading(): a navigation, a reload, a frame loading), and a navigation the action
//   scheduled has had its chance to start: an input that may navigate (a click, a key) leaves NAV_GRACE_MS for a click
//   handler's setTimeout to start one. Once the top frame committed a new document, the grace is over: the action's
//   navigation is that one, waited until it loads. A frame loading or a same-document route change (which Electron also
//   reports as a load) keeps the grace;
// - the network is quiet: no request in flight, or none of them active for NET_QUIET_MS (a long poll, a stream);
// - the page is quiet: no mutation the page agent saw (pageAgent.cjs) for DOM_QUIET_MS, and, for NET_QUIET_MS after
//   the grace, no network event either (a response the page still has to render; later, a page that polls more often
//   than that would never settle). requestAnimationFrame-driven JavaScript animations change style attributes, which
//   the observer sees; settling does not wait for a painted frame, since a page no window shows may not paint and a
//   capture waits for its own frame (hostCapture.cjs).
// A dialog, a closed tab or a crashed renderer ends the wait at once, the user's Stop interrupts it (loadInterruption.cjs),
// and a page that never goes quiet is read as it is after maxMs.
const { noteIgnored } = require('../../ignored.cjs');
const { withLoadInterruption } = require('./loadInterruption.cjs');
const { withTimeout } = require('./hostUtil.cjs');

/** How long after an input a navigation it scheduled (a click handler's setTimeout of up to 300 ms) may still start. */
const NAV_GRACE_MS = 350;
/** No DOM change for this long counts as quiet. */
const DOM_QUIET_MS = 80;
/** A request still open with no network activity for this long (a long poll, a stream) no longer holds the page. */
const NET_QUIET_MS = 300;
/** How often a busy page is looked at again; a load starting or stopping looks at once. */
const POLL_MS = 25;
/** The most a settle waits; the page is then read as it is. */
const SETTLE_MAX_MS = 5_000;
/** Events that end a poll early: a load started or stopped, or the top frame committed a new document. */
const WAKE = ['did-start-loading', 'did-stop-loading', 'did-navigate', 'destroyed'];

/**
 * @typedef {object} SettleProbe what a route can tell about its page
 * @property {import('node:events').EventEmitter & { isDestroyed(): boolean, isLoading(): boolean }} wc the page
 * @property {() => boolean} [ended] the page can't settle further (a dialog is up, the renderer is gone)
 * @property {() => { inflight: number, quietMs: number }} [net] requests in flight, and how long since the last network event
 * @property {() => Promise<{ quietMs: number, observeError?: string }>} [dom] how long the DOM has been quiet; none: not watched
 * @property {() => void} [onLoad] a load started (what was read of the old page is stale), at most once per settle
 */

/**
 * Waits until the page has settled (above), at most `maxMs`.
 * @param {SettleProbe} probe
 * @param {{ grace?: number, maxMs?: number }} [o] grace: how long a navigation the action scheduled may take to start
 */
function settlePage(probe, { grace = NAV_GRACE_MS, maxMs = SETTLE_MAX_MS } = {}) {
  const { wc } = probe;
  return withLoadInterruption(wc, async (wait) => {
    const start = Date.now();
    const deadline = start + maxMs;
    let loadSeen = false;
    const loadStarted = () => {
      if (loadSeen) return;
      loadSeen = true;
      probe.onLoad?.();
    };
    // the top frame committed a new document since the settle began (did-navigate is the top frame's, cross-document)
    let committed = false;
    const onCommit = () => void (committed = true);
    /** ends the current pause early; an event while the page is read wakes nothing (the read is followed by a look anyway) */
    /** @type {() => void} */
    let wake = () => undefined;
    const onEvent = () => wake();
    wc.on('did-start-loading', loadStarted);
    wc.on('did-navigate', onCommit);
    for (const e of WAKE) wc.on(e, onEvent);
    /** Sleeps `ms`, or until the page's load starts or stops. */
    const pause = (ms) =>
      wait(
        new Promise((resolve) => {
          const t = setTimeout(resolve, Math.max(1, Math.min(ms, deadline - Date.now())));
          t.unref?.();
          wake = () => {
            clearTimeout(t);
            resolve(undefined);
          };
        }),
      );
    try {
      while (Date.now() < deadline) {
        if (wc.isDestroyed() || probe.ended?.()) return;
        if (wc.isLoading()) {
          loadStarted();
          await pause(POLL_MS);
          continue;
        }
        const net = probe.net?.() ?? { inflight: 0, quietMs: Infinity };
        if (net.inflight > 0 && net.quietMs < NET_QUIET_MS) {
          await pause(POLL_MS);
          continue;
        }
        const left = grace - (Date.now() - start);
        if (!committed && left > 0) {
          await pause(left);
          continue;
        }
        if (!probe.dom) return;
        // the user's Stop still interrupts the read (wait); only the read's own failure is caught, and a read that
        // answers after the deadline leaves the page as it is
        const read = probe.dom().catch((error) => ({ quietMs: 0, readError: error }));
        const st = await wait(withTimeout(read, Math.max(1, deadline - Date.now()), () => ({ quietMs: Infinity })));
        if ('readError' in st) {
          // a document going away under the read is a load: wait for it; otherwise there is nothing more to watch
          if (!wc.isDestroyed() && wc.isLoading()) continue;
          noteIgnored('read whether the page is still changing after an action', st.readError);
          return;
        }
        if (st.observeError) {
          // the page could not be watched for changes, so there is no quiet DOM to wait for
          noteIgnored('watch the page for DOM changes after an action', st.observeError);
          return;
        }
        // a load that started while the page was read is waited for
        if (!wc.isDestroyed() && wc.isLoading()) continue;
        // a response that just arrived is still to be rendered: the quiet window counts from it too, for a while
        const netQuietMs = Date.now() - start < grace + NET_QUIET_MS ? (probe.net?.().quietMs ?? Infinity) : Infinity;
        const quietMs = Math.min(st.quietMs, netQuietMs);
        if (quietMs >= DOM_QUIET_MS) return;
        await pause(DOM_QUIET_MS - quietMs);
      }
    } finally {
      wc.removeListener('did-start-loading', loadStarted);
      wc.removeListener('did-navigate', onCommit);
      for (const e of WAKE) wc.removeListener(e, onEvent);
    }
  });
}

module.exports = { settlePage, NAV_GRACE_MS, DOM_QUIET_MS, NET_QUIET_MS, POLL_MS, SETTLE_MAX_MS };
