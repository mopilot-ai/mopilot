// Waits for the user to turn a macOS privacy switch on (#2528), a pure module both MoMo's sources and computer use use: after the exact pane was opened for a permission macOS will not ask for again, it reads the grant every couple of seconds and finishes the connect by itself, up to a timeout, and the user can cancel it. One watch per name; starting another replaces it; every start and end calls `onChange` so the windows read the list again.
/** How often the grant is read, and how long a watch waits for the user before it gives up. */
const INTERVAL_MS = 2000;
const TIMEOUT_MS = 3 * 60 * 1000;

// unref'd: a wait for the user never keeps the app (or a test process) alive
const wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

class GrantWatch {
  /**
   * @param {{ isGranted: (name: string) => Promise<boolean>, onGranted: (name: string, context: any) => unknown,
   *           onChange?: () => void, onError?: (what: string, error: unknown) => void, intervalMs?: number, timeoutMs?: number, sleep?: (ms: number) => Promise<unknown>,
   *           now?: () => number }} o
   *   isGranted: reads the grant now; onGranted: finishes what the grant was for (a failure ends the watch)
   */
  constructor({ isGranted, onGranted, onChange, onError, intervalMs = INTERVAL_MS, timeoutMs = TIMEOUT_MS, sleep = wait, now = Date.now }) {
    this.isGranted = isGranted;
    this.onGranted = onGranted;
    this.onChange = onChange;
    this.onError = onError;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.now = now;
    /** @type {Map<string, { cancelled: boolean }>} */
    this.active = new Map();
  }

  /** The names being waited for. */
  names() {
    return [...this.active.keys()];
  }

  /** Starts waiting for `name` (`context` goes to onGranted), replacing a watch already running for it. */
  start(/** @type {string} */ name, /** @type {any} */ context = undefined) {
    const old = this.active.get(name);
    if (old) old.cancelled = true;
    const watch = { cancelled: false };
    this.active.set(name, watch);
    void this.#run(name, watch, context);
    this.#changed();
  }

  /** Stops waiting for `name`; false when nothing was. */
  cancel(/** @type {string} */ name) {
    const watch = this.active.get(name);
    if (!watch) return false;
    watch.cancelled = true;
    this.active.delete(name);
    this.#changed();
    return true;
  }

  /** Tells the owner the set of waits changed; its failure never breaks a wait. */
  #changed() {
    try {
      this.onChange?.();
    } catch (error) {
      this.onError?.('announce a change in the waits for a macOS grant', error);
    }
  }

  async #run(/** @type {string} */ name, /** @type {{ cancelled: boolean }} */ watch, /** @type {any} */ context) {
    const deadline = this.now() + this.timeoutMs;
    try {
      while (!watch.cancelled && this.now() < deadline) {
        await this.sleep(this.intervalMs);
        if (watch.cancelled) break;
        const granted = await this.isGranted(name).catch((/** @type {unknown} */ e) => {
          this.onError?.('read a macOS grant while waiting for it', e);
          return false;
        });
        // a cancel while the grant was being read leaves the connect to the user
        if (granted && !watch.cancelled) {
          await this.onGranted(name, context);
          break;
        }
      }
    } catch (error) {
      // the grant arrived but what it was for could not finish (MoMo not allowed any more): the user presses Connect again
      this.onError?.('finish a connect after the macOS grant', error);
    } finally {
      // a replacing or cancelling call already took this watch's place
      if (this.active.get(name) === watch) {
        this.active.delete(name);
        this.#changed();
      }
    }
  }
}

module.exports = { GrantWatch, INTERVAL_MS, TIMEOUT_MS };
