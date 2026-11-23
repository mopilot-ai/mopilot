// Superagent lifecycle behind the `superagent` flag: while it is off nothing opens, polls or runs; a flip opens or closes the store.
// No Electron imports: the flag read, the store opener, the timers and the error sink are injected, so the core can later run in a Host process.

const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 60_000;
/** Damage and a newer schema need a person; anything else (a locked file) is retried. */
const needsPerson = (e) => e?.name === 'StoreDamagedError' || e?.name === 'StoreNewerError';
const timer = (fn, ms) => {
  const h = setTimeout(fn, ms);
  h.unref?.();
  return h;
};

/**
 * @param {object} o
 * @param {() => boolean} o.enabled reads the `superagent` flag
 * @param {() => any} o.openStore opens the store; throws StoreDamagedError for a damaged database
 * @param {(error: Error) => void} [o.onError] where a failure to open is shown
 * @param {(fn: () => void, ms: number) => unknown} [o.setTimer]
 * @param {(handle: unknown) => void} [o.clearTimer]
 */
function createSuperagent({
  enabled,
  openStore,
  onError = () => undefined,
  setTimer = timer,
  clearTimer = (h) => clearTimeout(/** @type {any} */ (h)),
}) {
  /** @type {any} */
  let store = null;
  /** @type {any} */
  let error = null;
  /** @type {Promise<void> | null} */
  let closing = null;
  let strikes = 0;
  /** @type {unknown} */
  let retry = null;

  const cancelRetry = () => {
    if (retry !== null) clearTimer(retry);
    retry = null;
  };

  /**
   * Call at start and on every flag change: opens when turned on, and when turned off stops handing out the store, waits
   * for running handlers and closes it. Returns the pending close, if any.
   * @returns {Promise<void> | undefined}
   */
  function sync() {
    if (!enabled()) {
      cancelRetry();
      if (!store) return closing ?? undefined;
      const old = store;
      store = null;
      const done = old
        .drain()
        .then(() => old.close())
        .finally(() => {
          closing = null;
        });
      closing = done;
      return done;
    }
    if (closing) return closing.then(() => sync());
    // a failed open waits for its own retry: a call to sync() never retries early, since opening blocks while a file is locked
    if (store || (error && needsPerson(error)) || retry !== null) return undefined;
    try {
      store = openStore();
      error = null;
      strikes = 0;
    } catch (e) {
      error = e;
      onError(e);
      if (!needsPerson(e)) {
        retry = setTimer(
          () => {
            retry = null;
            sync();
          },
          Math.min(RETRY_BASE_MS * 2 ** strikes, RETRY_CAP_MS),
        );
        strikes++;
      }
    }
    return undefined;
  }

  return {
    sync,
    get store() {
      return store;
    },
    get error() {
      return error;
    },
    /** A person's explicit action after damage: forget the error so the next sync may open a fresh database. */
    clearError() {
      error = null;
      strikes = 0;
    },
  };
}

module.exports = { createSuperagent };
