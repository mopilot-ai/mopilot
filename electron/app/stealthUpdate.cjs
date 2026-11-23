// Claude Desktop's stealth update: with an update downloaded and nothing to lose, the app restarts into it after ten unfocused minutes, without a dialog.
const { ignoring } = require('../ignored.cjs');

/** How long every condition must hold, without a break, before the restart (Claude Desktop: 10 minutes). */
const IDLE_MS = 10 * 60_000;
/** How often the conditions are read; a window gaining focus resets the wait at once (reset). */
const TICK_MS = 30_000;

/**
 * @param {object} o
 * @param {() => boolean} o.enabled the remote switch and the user's automatic updates
 * @param {() => boolean} o.ready an update is downloaded and Squirrel can install it
 * @param {() => boolean} o.focused one of the app's windows has focus
 * @param {() => boolean} o.fullScreen one of the app's windows is full screen
 * @param {() => Promise<boolean>} o.quiet quitting now would stop nothing and ask nothing (the exit gate)
 * @param {() => Promise<unknown>} o.install the restart (the updater's own, through the quiet exit gate)
 * @param {() => number} [o.now]
 * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [o.timers]
 */
function createStealthUpdate(o) {
  const now = o.now ?? Date.now;
  const timers = o.timers ?? { setInterval, clearInterval };
  /** @type {number | null} since when every condition has held */
  let since = null;
  let busy = false;
  let installing = false;
  /** Why the restart may not happen now, or null. */
  async function blocker() {
    if (!o.enabled()) return 'off';
    if (!o.ready()) return 'no update ready';
    if (o.focused()) return 'a window has focus';
    if (o.fullScreen()) return 'a window is full screen';
    if (!(await o.quiet())) return 'quitting would stop something or ask';
    return null;
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (await blocker()) {
        since = null;
        return;
      }
      since ??= now();
      if (now() - since < IDLE_MS) return;
      since = null;
      installing = true;
      try {
        await o.install();
      } finally {
        installing = false;
      }
    } finally {
      busy = false;
    }
  }
  const timer = timers.setInterval(() => void tick().catch(ignoring('check whether to restart into the update')), TICK_MS);
  timer.unref?.();
  return {
    tick,
    /** The user is back (a window took focus): the ten minutes start again. */
    reset: () => {
      since = null;
    },
    /** A restart this started is under way: the exit gate must not ask (it gives up instead). */
    get installing() {
      return installing;
    },
    stop: () => timers.clearInterval(timer),
  };
}

module.exports = { createStealthUpdate, IDLE_MS, TICK_MS };
