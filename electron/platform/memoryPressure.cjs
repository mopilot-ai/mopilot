// The system's memory pressure for every harness (#1830): normal, warning or critical, read from the OS on a timer.
// macOS reports it directly (kern.memorystatus_vm_pressure_level, the level Claude Desktop subscribes to natively); elsewhere
// it is the share of free memory, at Claude Desktop's thresholds. Subscribers hear every reading under pressure (they
// throttle themselves) and the return to normal once.
const os = require('node:os');
const { noteIgnored } = require('../ignored.cjs');
const { coreCall } = require('./core.cjs');

/** Twice a minute is enough for evictions that sweep at most once a minute. */
const POLL_MS = 30_000;
/** Below these shares of free memory (platforms without a pressure level), as Claude Desktop's CliGovernor. */
const WARNING_FREE = 0.05;
const CRITICAL_FREE = 0.02;

/** @typedef {'warning' | 'critical' | null} PressureLevel */

/** macOS's level: 1 normal, 2 warning, 4 critical. */
function levelOfDarwin(/** @type {string} */ out) {
  const n = Number(String(out).trim());
  return n === 4 ? 'critical' : n === 2 ? 'warning' : null;
}

const levelOfFree = (/** @type {number} */ ratio) => (ratio < CRITICAL_FREE ? 'critical' : ratio < WARNING_FREE ? 'warning' : null);

/** Read macOS's level from the Rust core; a read that fails (the route's error, noted) reads as no pressure. */
async function readDarwin(call = coreCall) {
  try {
    const level = await call('proc.pressure');
    return typeof level === 'number' ? levelOfDarwin(String(level)) : null;
  } catch (error) {
    noteIgnored("read the system's memory pressure", error);
    return null;
  }
}

/**
 * @param {object} [o]
 * @param {string} [o.platform]
 * @param {() => Promise<PressureLevel>} [o.read] the reading (defaults by platform)
 * @param {number} [o.pollMs]
 * @param {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [o.timers]
 */
function createMemoryPressure({
  platform = process.platform,
  read = platform === 'darwin' ? () => readDarwin() : async () => levelOfFree(os.freemem() / os.totalmem()),
  pollMs = POLL_MS,
  timers = { setInterval, clearInterval },
} = {}) {
  /** @type {PressureLevel} */
  let level = null;
  let timer = /** @type {any} */ (null);
  const subscribers = new Set();
  let reading = false;

  async function poll() {
    if (reading) return;
    reading = true;
    try {
      const next = await read();
      const was = level;
      level = next;
      if (next || was)
        for (const fn of subscribers)
          try {
            fn(next);
          } catch (error) {
            noteIgnored('tell a subscriber the memory pressure', error);
          }
    } finally {
      reading = false;
    }
  }

  return {
    poll,
    /** @returns {PressureLevel} */
    level: () => level,
    /** @param {(level: PressureLevel) => void} fn @returns {() => void} */
    subscribe(fn) {
      subscribers.add(fn);
      if (!timer) {
        timer = timers.setInterval(() => void poll(), pollMs);
        timer?.unref?.();
      }
      return () => {
        subscribers.delete(fn);
        if (!subscribers.size && timer) {
          timers.clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

/** @type {ReturnType<typeof createMemoryPressure> | null} */
let shared = null;
/** The app's one reading, polled while anything subscribes. */
const systemPressure = () => (shared ??= createMemoryPressure());

module.exports = { createMemoryPressure, systemPressure, levelOfDarwin, levelOfFree, readDarwin, POLL_MS };
