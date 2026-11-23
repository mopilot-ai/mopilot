// The errors a remote client sees: a stable code it can branch on and a message it may show.

/** The codes a reply's error.code may carry. */
const CODES = Object.freeze({
  invalid: 'invalid',
  forbidden: 'forbidden',
  stale: 'stale',
  gone: 'gone',
  failed: 'failed',
  send_uncertain: 'send_uncertain',
  send_conflict: 'send_conflict',
  send_unavailable: 'send_unavailable',
  send_capacity: 'send_capacity',
});

class RemoteError extends Error {
  /** @param {keyof typeof CODES} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = CODES[code];
  }
}

/** A refusal main already words and codes for the Mac's own window (a machine's chat start, a Switch host): the phone gets the same code and words. */
class RefusalError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A refusal's code as main names them: lower case words joined by underscores. */
const REFUSAL_CODE = /^[a-z][a-z_]{0,63}$/;

/** A thrown error that carries main's own code, as a RefusalError; any other error as it is. @param {unknown} error */
function asRefusal(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  if (!(error instanceof Error) || typeof code !== 'string' || !REFUSAL_CODE.test(code)) return error;
  return new RefusalError(code, error.message);
}

module.exports = { RemoteError, RefusalError, asRefusal, CODES };
