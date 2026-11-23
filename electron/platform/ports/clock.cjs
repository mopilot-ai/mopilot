// The clock port (docs/architecture/modularization.md §3): the time and the timers the layers above L1 read. It is the
// global clock until a test installs a fake (tests/support/ports/clock.ts), and each use reads what is installed. The
// global one reads Date and the timers when called, so node:test's mock.timers still reaches a module on the port.

/**
 * @typedef {{ now: () => number, setTimeout: typeof globalThis.setTimeout, clearTimeout: typeof globalThis.clearTimeout,
 *   setInterval: typeof globalThis.setInterval, clearInterval: typeof globalThis.clearInterval }} Clock
 */

/** @type {Clock} */
const globalClock = {
  now: () => Date.now(),
  setTimeout: /** @type {typeof globalThis.setTimeout} */ ((/** @type {any[]} */ ...a) => /** @type {any} */ (globalThis.setTimeout)(...a)),
  clearTimeout: (t) => globalThis.clearTimeout(t),
  setInterval: /** @type {typeof globalThis.setInterval} */ (
    (/** @type {any[]} */ ...a) => /** @type {any} */ (globalThis.setInterval)(...a)
  ),
  clearInterval: (t) => globalThis.clearInterval(t),
};

/** @type {Clock} */
let installed = globalClock;

/**
 * Put `impl` behind the port (null puts the global clock back), and return the one it replaced.
 * @param {Clock | null} impl
 */
function installClock(impl) {
  const previous = installed;
  installed = impl ?? globalClock;
  return previous;
}

/** The time and timers through the port: `clock.now()`, `clock.setTimeout(...)`. */
const clock = /** @type {Clock} */ (new Proxy({}, { get: (_target, key) => Reflect.get(installed, key) }));

module.exports = { clock, installClock };
