// A take-over is a pause the user ends with "Done, continue": the chat's input waits for it, and is never told it was stopped (#1905, #1906).
const { ToolError } = require('../contract/registry.cjs');
const { DONE_CONTINUE } = require('../../../shared/doneContinue.mjs');

/** How long input waits for the user to hand back what they took over before it gives up. */
const TAKEOVER_WAIT_MS = 10 * 60_000;

/** Stop, Esc or the turn's end while the input waited. */
const stoppedWaiting = () => new ToolError('Stopped by the user', 'refused');

/**
 * The user handed `what` back: the call that waited did nothing more, and the screen may have changed under the user.
 * @param {string} what
 */
const handedBack = (what) =>
  new ToolError(`The user took over ${what} and handed it back. Nothing more was done: take a new screenshot, then go on.`, 'changed');

/**
 * Waits on `waiters` until one of them is called: with nothing (handed back) or an error (stopped). The call's abort signal
 * stops the wait; after `ms` it fails with `capMessage`.
 * @param {Set<(err?: Error) => void>} waiters
 * @param {{ signal?: AbortSignal | null, ms: number, capMessage: string }} o
 * @returns {Promise<void>}
 */
function waitForHandBack(waiters, { signal, ms, capMessage }) {
  if (signal?.aborted) return Promise.reject(stoppedWaiting());
  return new Promise((resolve, reject) => {
    const done = (/** @type {Error | undefined} */ err) => {
      clearTimeout(timer);
      waiters.delete(done);
      signal?.removeEventListener?.('abort', aborted);
      if (err) reject(err);
      else resolve();
    };
    const aborted = () => done(stoppedWaiting());
    const timer = setTimeout(() => done(new ToolError(capMessage, 'busy')), ms);
    waiters.add(done);
    signal?.addEventListener?.('abort', aborted, { once: true });
  });
}

/** Whether a helper error is its guard refusing or cutting short input because the user moved the mouse or typed (not Esc). */
const isTakeoverError = (/** @type {any} */ e) => (e?.reason === 'paused' && !/escape/.test(String(e.message))) || e?.reason === 'aborted';

/**
 * The desktop take-over of the chat holding the screen: the helper's guard paused input because the user moved the mouse
 * or typed. It lasts until "Done, continue" (end), an Allow on one of the chat's cards (end), or Stop, Esc and the turn's end
 * (end with an error); the chat's input waits for it meanwhile.
 */
class DesktopTakeover {
  constructor(/** @type {{ ms?: number }} */ o = {}) {
    this.ms = o.ms ?? TAKEOVER_WAIT_MS;
    /** @type {string | null} the chat whose hold the user took over */
    this.chatId = null;
    /** @type {Set<(err?: Error) => void>} */
    this.waiters = new Set();
  }

  begin(/** @type {string} */ chatId) {
    this.chatId = chatId;
  }

  is(/** @type {string} */ chatId) {
    return !!chatId && this.chatId === chatId;
  }

  /** The take-over ended: waiting input goes on (no error: handed back) or fails with `err`. */
  end(/** @type {string} */ chatId, /** @type {Error | undefined} */ err = undefined) {
    if (!this.is(chatId)) return;
    this.chatId = null;
    for (const done of [...this.waiters]) done(err);
  }

  /** Input while the chat is taken over waits for the hand back; true when it waited. */
  async wait(/** @type {string} */ chatId, /** @type {AbortSignal | null | undefined} */ signal) {
    if (!this.is(chatId)) return false;
    await waitForHandBack(this.waiters, {
      signal,
      ms: this.ms,
      capMessage: `The user took over the mouse and keyboard and hasn't handed them back. Ask them to click "${DONE_CONTINUE}" in the chat.`,
    });
    return true;
  }
}

module.exports = { TAKEOVER_WAIT_MS, DesktopTakeover, waitForHandBack, handedBack, stoppedWaiting, isTakeoverError };
