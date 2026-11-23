// Why a Host's browser could not start, in words a person can act on (package 2.6): Chromium's own stderr names a missing library or a blocked sandbox, which a bare "The browser stopped." hid.

/** How long a failed start waits for the browser's own account of why it ended. */
export const CAUSE_MS = 1000;

/**
 * What a person can do about the way Chromium said it ended, or null when the text names nothing known.
 * @param {unknown} stderr
 * @returns {string | null}
 */
export function launchFailure(stderr) {
  const text = typeof stderr === 'string' ? stderr : '';
  const lib = /error while loading shared libraries: ([^\s:]+)/.exec(text);
  if (lib) return `The browser can't start: ${lib[1]} is missing on this machine. Install the libraries Chrome needs.`;
  if (/No usable sandbox/.test(text))
    return "The browser can't start: its sandbox is blocked on this machine. On Ubuntu 23.10 and later, allow user namespaces (kernel.apparmor_restrict_unprivileged_userns=0).";
  return null;
}

/**
 * The error a start that failed gives: a `browser_exited` error takes the cause from the browser's exit (waiting at most `ms` for it); any other error, or an exit that names nothing known, is returned as it was.
 * @param {any} error
 * @param {Promise<any>} exited settles when the browser process ends, with its stderr
 * @param {{ setTimer: typeof setTimeout, clearTimer: typeof clearTimeout }} timers
 * @param {number} [ms]
 */
export async function startFailure(error, exited, { setTimer, clearTimer }, ms = CAUSE_MS) {
  if (error?.code !== 'browser_exited') return error;
  /** @type {any} */
  let timer;
  const exit = await Promise.race([
    exited,
    new Promise((resolve) => {
      timer = setTimer(resolve, ms);
      timer.unref?.();
    }),
  ]);
  clearTimer(timer);
  const why = launchFailure(exit?.stderr);
  if (why) error.message = why;
  return error;
}
