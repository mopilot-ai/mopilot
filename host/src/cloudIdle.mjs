// A cloud machine's Host stops its own machine when idle (plan C2): what the Host reads of itself (turns, cards, queued messages, schedules, clients) as the probe of the pure decision in ./idleStop.mjs, on a timer, with the settings from the policy's `cloud` block (which only the app's document for a cloud machine carries; any other Host has none and never stops). The hours it has run today are kept in the data dir, so a restart does not lose them.
import fs from 'node:fs';
import path from 'node:path';
import { createIdleStop, osHalt } from './idleStop.mjs';

/** How often the Host looks at itself. */
export const TICK_MS = 30_000;
/** A client that sent something (other than a status look) this recently keeps the machine up. */
export const CLIENT_QUIET_MS = 60_000;
const FILE = 'cloud-hours.json';

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {() => { idleMinutes?: number, hoursPerDay?: number } | undefined} o.config the effective `cloud` block of the policy (none: this Host is not a cloud machine)
 * @param {() => { turnRunning: boolean, cardWaiting: boolean, queued: boolean }} o.busy what the chats are doing
 * @param {() => number | null} o.nextScheduleAt when the next scheduled task is due, or null
 * @param {() => Promise<unknown>} o.flush writes what must outlive the machine's stop
 * @param {() => Promise<void>} [o.halt] stops the machine (the operating system halts); a test passes its own
 * @param {() => number} [o.now]
 * @param {(m: string) => void} [o.report]
 * @param {Pick<typeof fs, 'readFileSync' | 'writeFileSync'>} [o.io]
 */
export function createCloudIdle({
  dataDir,
  config,
  busy,
  nextScheduleAt,
  flush,
  halt = osHalt(),
  now = Date.now,
  report = () => undefined,
  io = fs,
}) {
  const file = path.join(dataDir, FILE);
  let lastClientAt = Number.NEGATIVE_INFINITY;
  /** @type {{ key: string, idle: ReturnType<typeof createIdleStop> } | null} */
  let current = null;

  const store = {
    read: () => {
      try {
        return JSON.parse(String(io.readFileSync(file, 'utf8')));
      } catch {
        // none yet, or unreadable: the day starts at zero
        return null;
      }
    },
    write: (/** @type {{ day: string, ms: number }} */ v) => {
      try {
        io.writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
      } catch (error) {
        report(`cloud: the hours run today could not be kept (${/** @type {Error} */ (error).message})`);
      }
    },
  };

  /** The decision for the settings in force now; a changed setting makes a new one (the hours stay in the store). */
  function idleFor() {
    const cfg = config();
    if (!cfg) return (current = null);
    const key = JSON.stringify(cfg);
    if (current?.key !== key)
      current = {
        key,
        idle: createIdleStop({
          config: cfg,
          probe: () => ({ ...busy(), nextScheduleAt: nextScheduleAt(), clientActive: now() - lastClientAt < CLIENT_QUIET_MS }),
          now,
          flush: async () => void (await flush()),
          halt,
          store,
          report: (error) => report(`cloud: the machine did not stop (${error.message})`),
        }),
      };
    return current.idle;
  }

  return {
    /** A client sent a request that is not a status look. */
    touch: () => void (lastClientAt = now()),
    /** The `cloud` block of `host.status`, or null on a Host that is not a cloud machine. */
    status: () => idleFor()?.status() ?? null,
    /** One look; whether the machine began to stop. */
    tick: async () => (await idleFor()?.tick()) ?? false,
    /** Looks every `TICK_MS` until stopped; the timer never keeps the process alive. @returns {() => void} */
    start() {
      const timer = setInterval(() => void this.tick(), TICK_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
