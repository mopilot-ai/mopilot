// The proc port (docs/architecture/modularization.md §3): child processes as the layers above L1 start them. It is
// node:child_process until something else is installed: a test's fake (tests/support/ports/proc.ts) or a Host's tracking
// (host/src/children.mjs). Each use reads what is installed.
const childProcess = require('node:child_process');

/**
 * What can be installed: node:child_process, and maybe its own way to start a harness process.
 * @typedef {typeof import('node:child_process') & { spawnOwned?: (command: string, args: string[], options: object) => any }} ProcPort
 */

/** @type {ProcPort} */
let installed = childProcess;

/**
 * Put `impl` behind the port (null puts node:child_process back), and return the one it replaced.
 * @param {ProcPort | null} impl
 */
function installProc(impl) {
  const previous = installed;
  installed = impl ?? childProcess;
  return previous;
}

/** Child processes through the port: `proc.spawn(...)`, `proc.execFile(...)`. */
const proc = /** @type {typeof import('node:child_process')} */ (new Proxy({}, { get: (_target, key) => Reflect.get(installed, key) }));

/**
 * A harness process, stdio and all: the Rust core's (electron/platform/coreChild.cjs), through what is installed when that
 * has a `spawnOwned`, or from a test's stand-in with none, its `spawn`.
 * @type {(command: string, args: string[], options: object) => any}
 */
const spawnOwned = (command, args, options) => {
  const spawn = installed === childProcess ? require('../coreChild.cjs').spawnCore : (installed.spawnOwned ?? installed.spawn);
  return spawn(command, args, options);
};

module.exports = { proc, installProc, spawnOwned };
