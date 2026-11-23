// Tells paired phones their chat list changed, once for a burst: a phone reads the list again (it is kept live by this, never polled), so a new chat, a title, a state or a harness's list landing late reaches its screen within a second.

/** A burst of changes waits this long (the last one starts it over no further than MAX_MS) before the one event goes out. */
const QUIET_MS = 200;
const MAX_MS = 1_000;

/**
 * @param {object} o
 * @param {() => void} o.send tells every phone allowed the list
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [o.timers]
 * @param {number} [o.quietMs] @param {number} [o.maxMs]
 */
function createChatsChanged({ send, timers = globalThis, quietMs = QUIET_MS, maxMs = MAX_MS }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {number} when the burst began */
  let began = 0;
  const fire = () => {
    timer = null;
    send();
  };
  return {
    /** Something the list shows changed. */
    changed(/** @type {number} */ now = Date.now()) {
      if (timer === null) began = now;
      else timers.clearTimeout(timer);
      // a change keeps waiting for the burst to end, but never longer than maxMs since it began
      const wait = Math.max(0, Math.min(quietMs, began + maxMs - now));
      timer = timers.setTimeout(fire, wait);
      /** @type {any} */ (timer).unref?.();
    },
  };
}

module.exports = { createChatsChanged, QUIET_MS, MAX_MS };
