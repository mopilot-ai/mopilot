// Errors the Host raises for a request it cannot serve at all (not a malformed one); `code` is what the wire carries.

/** A request this Host cannot serve: a harness family it does not run, a setting it cannot change. */
export class UnsupportedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UnsupportedError';
    this.code = 'unsupported';
  }
}
