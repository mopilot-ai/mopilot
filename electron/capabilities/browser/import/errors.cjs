// Why reading another browser's data failed, as a stable code the import dialog turns into a sentence (access_blocked, read_failed, missing, too_large, keychain_denied, unsupported, storage_unavailable, no_file).
const CODES = [
  'missing',
  'access_blocked',
  'read_failed',
  'too_large',
  'keychain_denied',
  'unsupported',
  'storage_unavailable',
  'no_file',
  'busy',
  'cancelled',
];

class ImportError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message what happened, for logs (never a cookie value or key)
   */
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

/** An ImportError for any error a file read or database open raised: EPERM/EACCES block, ENOENT is missing, the rest a failed read. */
function classify(error) {
  if (error instanceof ImportError) return error;
  const code = /** @type {any} */ (error)?.code;
  if (code === 'EPERM' || code === 'EACCES') return new ImportError('access_blocked', 'The system blocked access to the browser data.');
  if (code === 'ENOENT') return new ImportError('missing', 'The browser data file does not exist.');
  return new ImportError('read_failed', error instanceof Error ? error.message : String(error));
}

module.exports = { CODES, ImportError, classify };
