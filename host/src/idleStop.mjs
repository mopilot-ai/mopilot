// A cloud machine's Host stops its own machine when it has been idle (Remote Run C2): idle means no turn running, no card waiting, no queued message, no schedule due within the idle time and no client connected and sending, for `idleMinutes`; a daily hours cap stops it after the running turn. It says so to its clients first (`status.cloud.stopping`) and writes its journal out, then halts the operating system. The decision is pure on injected probes and clock, so each condition and its edge are tested without a machine.
import { spawn } from 'node:child_process';

const MIN = 60_000;
const HOUR = 3_600_000;
export const DEFAULT_IDLE_MINUTES = 30;

/** The UTC day a time falls on, the unit of the hours cap. @param {number} t */
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * @typedef {{ turnRunning: boolean, cardWaiting: boolean, queued: boolean, nextScheduleAt: number | null, clientActive: boolean }} IdleProbe
 * @param {object} o
 * @param {{ idleMinutes?: number, hoursPerDay?: number | null }} o.config `hoursPerDay`: null or 0 is no cap
 * @param {() => IdleProbe} o.probe what the Host is doing now
 * @param {() => number} o.now
 * @param {() => Promise<void>} o.flush writes the journal out before the machine stops
 * @param {() => Promise<void>} o.halt stops the machine (the operating system halts; the provider sees a stopped machine)
 * @param {{ read: () => { day: string, ms: number } | null, write: (v: { day: string, ms: number }) => void }} o.store the hours run today, kept across a Host restart
 * @param {(error: Error) => void} [o.report]
 */
export function createIdleStop({ config, probe, now, flush, halt, store, report = () => undefined }) {
  const idleMs = Math.max(1, config.idleMinutes ?? DEFAULT_IDLE_MINUTES) * MIN;
  const capMs = config.hoursPerDay ? config.hoursPerDay * HOUR : 0;
  /** When the Host last was busy ended, or null while it is busy. @type {number | null} */
  let idleSince = null;
  let last = now();
  const saved = store.read();
  let day = dayOf(last);
  let runMs = saved?.day === day ? saved.ms : 0;
  let stopping = false;
  /** @type {'idle' | 'hours' | null} */
  let reason = null;
  /** @type {Set<(s: ReturnType<typeof status>) => void>} */
  const listeners = new Set();

  function status() {
    return { idleMinutes: idleMs / MIN, stopping, hoursToday: Math.round((runMs / HOUR) * 100) / 100, ...(reason ? { reason } : {}) };
  }
  const tell = () => {
    for (const fn of [...listeners]) fn(status());
  };

  /** @param {'idle' | 'hours'} why */
  async function stop(why) {
    stopping = true;
    reason = why;
    tell();
    try {
      await flush();
      await halt();
    } catch (error) {
      // the machine did not stop: it is not stopping, and the next tick may try again
      stopping = false;
      reason = null;
      idleSince = null;
      tell();
      report(/** @type {Error} */ (error));
    }
  }

  return {
    status,
    /** Told with the new status when the machine starts stopping or fails to. @param {(s: ReturnType<typeof status>) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** One look at the Host: counts the hours, and stops the machine if it is time. Returns whether a stop began. */
    async tick() {
      const t = now();
      if (stopping) return false;
      if (dayOf(t) !== day) {
        // only the part of the gap since midnight counts toward the new day
        day = dayOf(t);
        runMs = 0;
        last = Math.max(last, Date.parse(`${day}T00:00:00Z`));
      }
      runMs += Math.max(0, t - last);
      last = t;
      store.write({ day, ms: runMs });
      const p = probe();
      // the cap waits for the running turn, and for nothing else
      if (capMs && runMs >= capMs && !p.turnRunning) {
        await stop('hours');
        return true;
      }
      const soon = p.nextScheduleAt !== null && p.nextScheduleAt - t <= idleMs;
      if (p.turnRunning || p.cardWaiting || p.queued || p.clientActive || soon) {
        idleSince = null;
        return false;
      }
      idleSince ??= t;
      if (t - idleSince < idleMs) return false;
      await stop('idle');
      return true;
    },
  };
}

/**
 * Halt this machine's operating system: the provider treats a halted machine as stopped. `sudo -n` first (a Host run as a user), then the plain call.
 * @param {typeof spawn} [spawnFn]
 */
export function osHalt(spawnFn = spawn) {
  /** @param {string[]} argv */
  const run = (argv) =>
    new Promise((resolve, reject) => {
      const child = spawnFn(argv[0], argv.slice(1), { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`halt exited ${code}`))));
    });
  return async () => {
    try {
      await run(['sudo', '-n', 'systemctl', 'poweroff']);
    } catch {
      await run(['systemctl', 'poweroff']);
    }
  };
}
