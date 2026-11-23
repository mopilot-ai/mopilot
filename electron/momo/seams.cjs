// What MoMo is given by the place that runs it (M1, designs/momo-m1-home): its sealed storage (a folder and a key source), its clock and its scheduler, so a MoMo module never reaches for Electron or a timer itself and the Mac app's main process and a Host run the same code.
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { userError } = require('../../shared/userError.mjs');

/** @typedef {import('../platform/secretFile.cjs').SafeStorage} SafeStorage */
/** @typedef {{ now: () => number, after: (fn: () => void, ms: number) => () => void }} Clock */
/**
 * @typedef {object} TickTask
 * @property {string} id
 * @property {(after: number) => number | null} next the first due time strictly after `after`, null when there is none
 * @property {(dueAt: number) => Promise<unknown> | unknown} run
 * @property {number} [since] when the task was last handled (a restart reads it back), so one missed due time can still run
 */

/** Where the key that seals MoMo's files comes from: Electron's safeStorage on the Mac, a 0600 key file on a Host. */
const KEY_KINDS = Object.freeze(['electron', 'key-file']);

/**
 * MoMo's storage as every store opens it: its folder and the sealed storage over a key source. A mistake in either is
 * found here, once, instead of as a store that cannot write.
 * @param {{ dir: string, keySource: { kind: 'electron' | 'key-file', safeStorage: SafeStorage } }} o
 */
function momoStorage({ dir, keySource }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('MoMo’s storage needs an absolute folder');
  if (!keySource || !KEY_KINDS.includes(keySource.kind)) throw new Error('MoMo’s storage needs a key source');
  const safe = keySource.safeStorage;
  if (
    !safe ||
    ['isEncryptionAvailable', 'encryptString', 'decryptString'].some((m) => typeof (/** @type {any} */ (safe)[m]) !== 'function')
  )
    throw new Error('MoMo’s key source cannot seal');
  return Object.freeze({ dir, safeStorage: safe, keys: keySource.kind });
}

/** How long one task's run may take before it is recorded "Didn't finish" and the next task goes on: thirty minutes, the time a waiting approval card waits before it pauses its run. */
const RUN_TIMEOUT_MS = 30 * 60_000;

/** The real clock. @type {Clock} */
const systemClock = Object.freeze({
  now: () => Date.now(),
  after: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
});

/**
 * @typedef {object} TaskOutcome what the scheduler tells `record` about a due time, so the owner can keep it
 * @property {string} id
 * @property {number} dueAt
 * @property {'started' | 'ran' | 'didnt-finish' | 'late' | 'skipped'} status `started` is written (and awaited) before the run, so a Host that stops mid-run finds a start with no end and reads it as "Didn't finish" when it is back; `skipped` is a run that declined its time on purpose (quiet hours, the daily limit, nothing due), which is not a failure
 * @property {number} at
 * @property {string} [error] why it did not finish, in words a person can read (the raw error goes to `report`)
 */

/** A run that declines its due time on purpose (quiet hours, the daily limit, nothing due): recorded `skipped`, not `didnt-finish`, and not reported. */
class TaskSkipped extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`The run was skipped: ${reason}`);
    this.reason = reason;
  }
}

/**
 * MoMo's scheduler contract and its reference implementation. The rules:
 * - a due time runs once; a task that is late runs once, never once per period it missed;
 * - a due time more than `lateMs` before the tick began is `late`: not run, recorded as late. Lateness is measured against
 *   when the tick began, so a task that waited only because another task's run was long is not late;
 * - a run that throws is recorded `didnt-finish` and reported, never dropped silently, and the schedule goes on; one that throws `TaskSkipped` is recorded `skipped` and not reported;
 * - a run starts only after its `started` mark was recorded: a mark that cannot be recorded (the record rejects) is reported and the run does not start, so a due time can never run without a trace a restart can read;
 * - tasks run one at a time, a run that has not settled after `runTimeoutMs` (thirty minutes) is recorded `didnt-finish` and the tick goes on, and a tick that arrives while one still runs is skipped, never queued;
 * - a task whose `next` throws is parked and recorded `didnt-finish`; it never stops the other tasks;
 * - a task whose next due time is not after now is parked and reported, so it cannot run on every tick;
 * - due times are absolute: a clock that moves back runs nothing twice, tasks just wait until it catches up.
 * The app's scheduler and a Host's `tick()` drive it; `record` is where its owner keeps the outcomes.
 * @param {{ clock?: Clock, lateMs?: number, runTimeoutMs?: number, record?: (outcome: TaskOutcome) => void, report?: (id: string, error: unknown) => void }} [o]
 */
function createTickScheduler({
  clock = systemClock,
  lateMs = 3_600_000,
  runTimeoutMs = RUN_TIMEOUT_MS,
  record = () => undefined,
  report = (id, error) => noteIgnored(`run MoMo task ${id}`, error),
} = {}) {
  /** @type {Map<string, { task: TickTask, dueAt: number | null }>} */
  const tasks = new Map();
  let ticking = false;
  /** @type {(() => void) | null} */
  let cancel = null;
  let generation = 0;
  /** The owner's record never breaks a tick; true when it was kept. @param {TaskOutcome} outcome */
  const note = async (outcome) => {
    try {
      await record(outcome);
      return true;
    } catch (error) {
      report(outcome.id, error);
      return false;
    }
  };
  /** The run, or a rejection when it has not settled in `runTimeoutMs`. @param {() => unknown} run */
  const within = (run) =>
    new Promise((resolve, reject) => {
      const cancel = clock.after(() => reject(new Error('it did not finish in time')), runTimeoutMs);
      new Promise((started) => started(run())).then(resolve, reject).finally(cancel);
    });
  const scheduler = {
    /** Add a task (replacing one of the same id); its first due time follows `since`, else now. @param {TickTask} task */
    add(task) {
      tasks.set(task.id, { task, dueAt: task.next(task.since ?? clock.now()) });
    },
    /** @param {string} id */
    remove(id) {
      tasks.delete(id);
    },
    /** What is scheduled: each task's next due time. */
    list: () => [...tasks].map(([id, t]) => ({ id, dueAt: t.dueAt })),
    /** Run what is due now. @returns {Promise<{ ran: string[], failed: string[], late: string[], skipped: string[], busy: boolean }>} */
    async tick() {
      const out = {
        ran: /** @type {string[]} */ ([]),
        failed: /** @type {string[]} */ ([]),
        late: /** @type {string[]} */ ([]),
        skipped: /** @type {string[]} */ ([]),
        busy: false,
      };
      if (ticking) return { ...out, busy: true };
      ticking = true;
      const began = clock.now();
      try {
        for (const [id, entry] of [...tasks]) {
          const now = clock.now();
          if (entry.dueAt === null || entry.dueAt > now || tasks.get(id) !== entry) continue;
          const dueAt = entry.dueAt;
          /** @type {number | null} */
          let after = null;
          try {
            after = entry.task.next(now);
          } catch (error) {
            entry.dueAt = null;
            out.failed.push(id);
            await note({ id, dueAt, status: 'didnt-finish', at: now, error: userError(error) });
            report(id, error);
            continue;
          }
          if (after !== null && after <= now) report(id, new Error('its next due time is not after now, so it is parked'));
          entry.dueAt = after !== null && after > now ? after : null;
          if (began - dueAt > lateMs) {
            out.late.push(id);
            await note({ id, dueAt, status: 'late', at: now });
            continue;
          }
          // no mark, no run: a restart must be able to read what was started
          if (!(await note({ id, dueAt, status: 'started', at: now }))) {
            out.failed.push(id);
            continue;
          }
          try {
            await within(() => entry.task.run(dueAt));
            out.ran.push(id);
            await note({ id, dueAt, status: 'ran', at: clock.now() });
          } catch (error) {
            if (error instanceof TaskSkipped) {
              out.skipped.push(id);
              await note({ id, dueAt, status: 'skipped', at: clock.now() });
              continue;
            }
            out.failed.push(id);
            await note({ id, dueAt, status: 'didnt-finish', at: clock.now(), error: userError(error) });
            report(id, error);
          }
        }
      } finally {
        ticking = false;
      }
      return out;
    },
    /** Tick every `everyMs` until stop(); a second start() replaces the first. @param {number} everyMs */
    start(everyMs) {
      const mine = ++generation;
      const again = () => {
        cancel = clock.after(
          () =>
            void scheduler
              .tick()
              .catch((error) => report('tick', error))
              .finally(() => generation === mine && again()),
          everyMs,
        );
      };
      cancel?.();
      again();
    },
    stop() {
      generation++;
      cancel?.();
      cancel = null;
    },
  };
  return scheduler;
}

module.exports = { momoStorage, systemClock, createTickScheduler, TaskSkipped, KEY_KINDS, RUN_TIMEOUT_MS };
