// The pane's view of a tab on a remote Host: frames by screenshot polling (design/host/index.html, package 2.6), never a stream.
//
// While the pane is visible a tab's frame is fetched about once a second during a takeover, where the user acts on it, and
// more slowly otherwise, so a page the agent is driving does not cross the tunnel at the takeover rate. One fetch is in
// flight per watch and the next waits for it; a frame that arrives after the pane hid or the watch stopped is dropped.
// A fetch that never answers is given up on (its late answer is ignored), so the polling goes on.

const { noteIgnored } = require('../../ignored.cjs');
/** Frame callbacks must not stop future polling when a window closes during publication. */
const notify = (fn) => {
  try {
    fn();
  } catch (error) {
    noteIgnored('publish a remote frame', error);
  }
};

/** Frame interval while the user has taken over the tab. */
const TAKEOVER_MS = 1000;
/** Frame interval while the pane only watches. */
const WATCH_MS = 3000;
/** How long one fetch may take. */
const FETCH_MS = 8000;

/**
 * @param {object} o
 * @param {(chatId: string, tabKey: string | null) => Promise<{ data: Buffer, mime: string }>} o.fetch one frame (RemoteTabs.frame)
 * @param {number} [o.activeMs] optional action cadence; only opted-in desktop watches use it
 * @param {number} [o.takeoverMs] @param {number} [o.watchMs] @param {number} [o.fetchMs]
 * @param {typeof setTimeout} [o.setTimer] @param {typeof clearTimeout} [o.clearTimer]
 */
function createFramePoller({
  fetch,
  activeMs = TAKEOVER_MS,
  takeoverMs = TAKEOVER_MS,
  watchMs = WATCH_MS,
  fetchMs = FETCH_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /**
   * Follows one tab. Frames and failures go to `onFrame` and `onError`; polling starts when the pane is visible.
   * @param {{ chatId: string, tabKey: string | null, onFrame: (frame: { data: Buffer, mime: string }) => void, onError?: (error: unknown) => void }} w
   */
  function watch({ chatId, tabKey, onFrame, onError }) {
    let stopped = false;
    let visible = false;
    let takeover = false;
    let fetching = false;
    let active = false;
    let urgent = false;
    /** the last capture has not answered although the poller gave up on it: another would queue behind it on a hung page */
    let outstanding = false;
    /** @type {any} */
    let timer = null;

    const schedule = (ms) => {
      clearTimer(timer);
      timer = null;
      if (stopped || !visible) return;
      timer = setTimer(tick, ms);
      timer.unref?.();
    };

    function tick() {
      timer = null;
      // the pane hid and showed again while a fetch was out: that fetch is the next frame
      if (fetching) return;
      // a capture the poller gave up on is still out: look again soon when an action's frame is owed
      if (outstanding) return schedule(urgent ? activeMs : watchMs);
      urgent = false;
      fetching = true;
      let gaveUp = false;
      /** @type {any} */
      let fetchTimer = null;
      const settle = () => {
        if (gaveUp) return false;
        gaveUp = true;
        clearTimer(fetchTimer);
        fetching = false;
        return true;
      };
      fetchTimer = setTimer(() => {
        if (settle()) {
          if (!stopped && visible) notify(() => onError?.(Object.assign(new Error('The page did not answer.'), { code: 'fetch_timeout' })));
          // an action settled while this was out: its frame is owed soon, not a watch tick later (the shared budget still caps it)
          schedule(urgent ? activeMs : watchMs);
        }
      }, fetchMs);
      fetchTimer.unref?.();
      outstanding = true;
      const capture = Promise.resolve().then(() => fetch(chatId, tabKey));
      const done = () => {
        outstanding = false;
      };
      capture.then(done, done);
      capture.then(
        (frame) => {
          if (!settle()) return;
          // a frame that finished after the pane hid is not shown
          if (!stopped && visible) notify(() => onFrame(frame));
          schedule(urgent ? 0 : active ? activeMs : takeover ? takeoverMs : watchMs);
        },
        (error) => {
          if (!settle()) return;
          if (!stopped && visible) notify(() => onError?.(error));
          schedule(urgent || /** @type {any} */ (error)?.code === 'stale_frame' ? activeMs : watchMs);
        },
      );
    }

    function refresh() {
      if (stopped || !visible || urgent) return;
      urgent = true;
      if (!fetching) schedule(0);
    }

    return {
      /** A frame after an action, coalesced with any pending capture. */
      refresh,
      /** An action is still running; use the opted-in cadence until it ends. @param {boolean} on */
      setActive(on) {
        if (stopped || active === on) return;
        active = on;
        if (on) refresh();
        else if (visible && !fetching && !urgent) schedule(takeover ? takeoverMs : watchMs);
      },
      /** The pane is shown or hidden; hiding stops the polling, showing takes a frame at once. @param {boolean} on */
      setVisible(on) {
        if (stopped || visible === on) return;
        visible = on;
        if (on) tick();
        else {
          clearTimer(timer);
          timer = null;
        }
      },
      /** The user took over the tab or handed it back. @param {boolean} on */
      setTakeover(on) {
        if (stopped || takeover === on) return;
        takeover = on;
        if (visible && !fetching && !active && !urgent) schedule(on ? takeoverMs : watchMs);
      },
      stop() {
        stopped = true;
        clearTimer(timer);
        timer = null;
      },
    };
  }
  return { watch };
}

module.exports = { createFramePoller, TAKEOVER_MS, WATCH_MS, FETCH_MS };
