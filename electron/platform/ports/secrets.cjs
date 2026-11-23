// The secrets port (docs/architecture/modularization.md §3): the safeStorage a process encrypts its secrets with. In the app it is Electron's; the Host installs one over a key file of its own (host/src/secretStore.mjs), so the modules that keep secrets (secretFile.cjs) run there without Electron. Each use reads what is installed.
const { electron } = require('./electronApi.cjs');

/** @typedef {import('../secretFile.cjs').SafeStorage} SafeStorage */

/** @type {() => SafeStorage | null} */
const electronSafe = () => electron?.safeStorage ?? null;

/** @type {() => SafeStorage | null} */
let installed = electronSafe;

/**
 * Put `impl` behind the port (null puts Electron's back), and return the one it replaced.
 * @param {(() => SafeStorage | null) | null} impl
 */
function installSecrets(impl) {
  const previous = installed;
  installed = impl ?? electronSafe;
  return previous;
}

/** The safeStorage through the port: `secrets.safeStorage()`, null when this process has none. */
const secrets = { safeStorage: () => installed() };

module.exports = { secrets, installSecrets };
