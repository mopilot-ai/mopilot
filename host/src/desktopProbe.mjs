// Whether this Host can serve a desktop right now (G8, #3903): the answer `status` reports as capabilities.desktop. It is a real reading, never a guess from daemon startup, VM detection or a connected client: the helper is started the way a lease starts it, and what it says about its macOS grants decides. A Host in launchd's system domain cannot start the helper in the logged-in session, so it reads false; so does one before login or after logout.
//
// `ok()` is what `status` calls on every request and the heartbeat reads, so it never starts or waits for anything: it answers from the last reading, and only while that reading is fresh (an answer older than `staleMs` is false, since a cached true after a logout would be a capability the Host does not have). The reading is refreshed in the background, one at a time, with a timeout. It asks for permission state only; nothing here can show a macOS prompt.

/** The grants the desktop tools cannot work without (Input Monitoring only serves the helper's guard against a person's keys). */
const NEEDED = /** @type {const} */ ([
  ['accessibility', 'Accessibility'],
  ['screenRecording', 'Screen Recording'],
]);

/**
 * @param {object} o
 * @param {boolean | (() => boolean)} o.installed whether there is a helper to start on this machine (a function is asked at each reading: the helper app may be provisioned after the Host started)
 * @param {(method: string, params: object, opts: { timeoutMs: number }) => Promise<any>} o.call the helper (computer.cjs ComputerHelper.call)
 * @param {() => number} [o.now]
 * @param {number} [o.refreshMs] how often the reading is renewed
 * @param {number} [o.staleMs] how long a reading counts
 * @param {number} [o.timeoutMs] how long one reading may take
 * @param {typeof setInterval} [o.setTimer] @param {typeof clearInterval} [o.clearTimer]
 */
export function createDesktopProbe({
  installed,
  call,
  now = Date.now,
  refreshMs = 30_000,
  staleMs = 90_000,
  timeoutMs = 10_000,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  /** @type {{ ok: boolean, why: string, at: number }} */
  let reading = { ok: false, why: 'This Host has not checked its desktop yet.', at: Number.NEGATIVE_INFINITY };
  /** @type {Promise<void> | null} */
  let reading$ = null;
  /** @type {any} */
  let timer = null;
  let stopped = false;
  /** bumped when the Host stops trusting what it knows: a reading that began before that is not kept */
  let generation = 0;
  const isInstalled = typeof installed === 'function' ? installed : () => installed;

  async function read() {
    const mine = generation;
    const set = (/** @type {boolean} */ ok, /** @type {string} */ why) => {
      if (!stopped && mine === generation) reading = { ok, why, at: now() };
    };
    if (!isInstalled()) return set(false, 'The desktop helper is not installed on this Host.');
    try {
      const status = await call('permissions.status', {}, { timeoutMs });
      const missing = NEEDED.filter(([key]) => status?.[key] !== true).map(([, label]) => label);
      if (missing.length > 0) return set(false, `macOS has not granted ${missing.join(' and ')} to the desktop helper on this Host.`);
      return set(true, '');
    } catch (e) {
      return set(false, `This Host cannot reach its desktop: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** One reading at a time: a caller that comes while one is out waits for that one. */
  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (!reading$) {
      const mine = read().finally(() => {
        if (reading$ === mine) reading$ = null;
      });
      reading$ = mine;
    }
    return reading$;
  };

  return {
    /** Whether the desktop can be served: the last reading says so and is recent. Never starts anything. */
    ok: () => reading.ok && now() - reading.at <= staleMs,
    /** Why not, in words for the person. */
    why: () => (reading.ok && now() - reading.at > staleMs ? 'This Host has not confirmed its desktop lately.' : reading.why),
    /** The session may have changed (the helper went, a call failed): the Host is no longer sure until it looks again. */
    recheck: () => {
      generation += 1;
      reading = { ok: false, why: 'This Host is checking its desktop.', at: now() };
      // a reading already out began before this moment: it is let go, and a new one starts
      reading$ = null;
      void refresh();
    },
    refresh,
    /** Reads once now, then every `refreshMs`. */
    start() {
      void refresh();
      timer ??= setTimer(() => void refresh(), refreshMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
