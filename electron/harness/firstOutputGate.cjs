// Holds a Claude Code chat's fallback title helper (a CLI of its own) until the chat's own turn shows model output
// or ends, so starting it never competes with that turn's start on the same account (#1651).
const { clock } = require('../platform/ports/clock.cjs');

/** The longest a helper waits: a turn whose output never reaches the gate still gets its title. */
const MAX_HOLD_MS = 20_000;

class FirstOutputGate {
  constructor(maxHoldMs = MAX_HOLD_MS) {
    this.maxHoldMs = maxHoldMs;
    /** key -> { promise, release, timer } */
    this.held = new Map();
  }

  /**
   * A promise that settles at the key's first output (open) or after maxHoldMs. Armed before the turn is sent, so
   * output that arrives before the send resolves is not missed.
   * @returns {Promise<void>}
   */
  arm(key) {
    const cur = this.held.get(key);
    if (cur) return cur.promise;
    /** @type {(value: void) => void} */
    let release = /** @type {any} */ (null);
    /** @type {Promise<void>} */
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    const timer = clock.setTimeout(() => this.open(key), this.maxHoldMs);
    timer.unref?.();
    this.held.set(key, { promise, release, timer });
    return promise;
  }

  /** The key's turn streamed, ended or never started: whatever waits on it goes now. */
  open(key) {
    const cur = this.held.get(key);
    if (!cur) return;
    this.held.delete(key);
    clock.clearTimeout(cur.timer);
    cur.release();
  }

  /** The server is gone: nothing it would have said is still coming. */
  openAll() {
    for (const key of [...this.held.keys()]) this.open(key);
  }
}

module.exports = { FirstOutputGate, MAX_HOLD_MS };
