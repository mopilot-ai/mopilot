// The Chromium-family "Safe Storage" key from the macOS keychain, fetched asynchronously because the keychain prompt can wait for the user for minutes.
const { proc: childProcess } = require('../../../platform/ports/proc.cjs');
const { deriveKey } = require('../../../../shared/chromiumCrypto.cjs');
const { ImportError } = require('./errors.cjs');

const DENIED = 'The keychain did not give MoPilot the browser key.';

/**
 * The 16-byte AES key for a browser's cookies, or an ImportError('keychain_denied') when macOS refuses, the
 * prompt times out or this is not macOS. The password is never logged or put in an error.
 * @param {string} service e.g. "Chrome Safe Storage"
 * @param {{ execFile?: Function, platform?: string, timeoutMs?: number }} [o]
 * @returns {Promise<Buffer>}
 */
async function chromiumKey(service, { execFile = childProcess.execFile, platform = process.platform, timeoutMs = 120000 } = {}) {
  if (platform !== 'darwin') throw new ImportError('keychain_denied', DENIED);
  /** @type {string} */
  let password;
  try {
    password = await new Promise((resolve, reject) => {
      execFile('security', ['find-generic-password', '-w', '-s', service], { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) =>
        error ? reject(error) : resolve(String(stdout)),
      );
    });
  } catch {
    // the error text can quote the command line; only the stable code is kept
    throw new ImportError('keychain_denied', DENIED);
  }
  if (password.endsWith('\n')) password = password.slice(0, -1);
  if (!password) throw new ImportError('keychain_denied', DENIED);
  return deriveKey(password);
}

/** Overwrites a key buffer once it is no longer needed. @param {Buffer | null | undefined} buf */
function zeroKey(buf) {
  buf?.fill(0);
}

module.exports = { chromiumKey, zeroKey };
