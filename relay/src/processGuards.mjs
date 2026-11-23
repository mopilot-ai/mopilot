// Process-level safety net for the relay: one request's stray error is logged and the relay keeps serving, anything else ends the process for its supervisor (Docker's restart policy) to start again.

/** Errors of a single dead socket that reach the process when a handler missed them; they say nothing about the relay's own state. */
export const SOCKET_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED',
  'ENOTCONN',
]);

/** How many stray errors the guards have seen, by event; the relay's /metrics reports them. */
export const processErrors = { unhandled_rejection: 0, uncaught_exception: 0 };

/** An error as one short log line: its message, cut, and never a failure of its own (an object with no prototype, a symbol). */
export const messageOf = (/** @type {unknown} */ e) => {
  try {
    // a database error can quote the value it refused (`invalid input syntax for type uuid: "..."`): the value is not logged
    return String(/** @type {any} */ (e)?.message ?? e)
      .replace(/: "[^"]*"/g, ': "…"')
      .slice(0, 200);
  } catch {
    return 'unprintable error';
  }
};

/**
 * @param {object} [o] the real process, a JSON line on stderr and process.exit unless a test passes its own
 * @param {Pick<NodeJS.Process, 'on'>} [o.proc]
 * @param {(event: string, data: object) => void} [o.log]
 * @param {(code: number) => void} [o.exit]
 */
export function installProcessGuards({
  proc = process,
  log = (/** @type {string} */ event, /** @type {object} */ data) => console.error(JSON.stringify({ event, ...data })),
  exit = (/** @type {number} */ code) => process.exit(code),
} = {}) {
  const say = (/** @type {unknown} */ e) => ({ message: messageOf(e), code: /** @type {any} */ (e)?.code });
  proc.on('unhandledRejection', (reason) => {
    processErrors.unhandled_rejection++;
    log('unhandled_rejection', say(reason));
  });
  proc.on('uncaughtException', (error) => {
    processErrors.uncaught_exception++;
    log('uncaught_exception', say(error));
    if (!SOCKET_ERROR_CODES.has(/** @type {any} */ (error)?.code)) exit(1);
  });
}
