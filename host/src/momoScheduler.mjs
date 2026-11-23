// MoMo's scheduler on a Host (M1 H3a, designs/momo-m1-home): MoMo's routines and nudge check fire from the Host's own clock while the home is active, with no app open. A tick runs only while the home's stores are open (a live grant and an active home), every run's start is on disk before the run begins (a Host that stops mid-run reads "Didn't finish" when it is back, and never runs that due time again), and a run that declines its time on purpose is recorded as skipped.
import path from 'node:path';
import { createRequire } from 'node:module';
import { describeError } from '../../shared/userError.mjs';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../../electron/gateway/sealedFile.cjs');
const { createTickScheduler, TaskSkipped, systemClock } = require('../../electron/momo/seams.cjs');
const { RunSkipped } = require('../../electron/platform/scheduler.cjs');

/** How often due times are looked at. */
export const TICK_MS = 30_000;
/** What a run that was under way when the Host stopped is told. */
const STOPPED = 'MoMo’s Host stopped while this was running.';

/**
 * @typedef {object} MomoTask a MoMo task as MoMo's routines service lists it (electron/momo/routines.cjs)
 * @property {string} id
 * @property {string} rrule
 * @property {string} [status] only `ACTIVE` tasks are scheduled
 * @property {number} [schedule_from] when its schedule began: nothing before it runs
 * @property {string} [zone] the clock the rule's hours are read on (this Host's own when none)
 */
/**
 * @typedef {object} TaskSource what runs MoMo's tasks, given by the layer above (H3b): the tasks now, one run, and what to do with the runs a stop cut off
 * @property {() => MomoTask[] | Promise<MomoTask[]>} list
 * @property {(task: MomoTask, ctx: { stamp: { homeId: string, leaseEpoch: number } | null, live: () => Promise<boolean> }) => Promise<unknown> | unknown} run throws `RunSkipped` for a time it declines; `ctx.stamp` is the home's lease the run was begun under and `ctx.live()` says whether it still is (a run checks it before each effect, not only at its start)
 * @property {(task: MomoTask, error: unknown) => unknown} [failed] a run that threw, so MoMo's chat can be told
 * @property {(runs: { id: string, dueAt: number }[]) => unknown} [interrupted] runs a stop cut off, found at boot
 */

/** @param {any} v */
const ledgerShape = (v) => ({
  tasks: v?.tasks && typeof v.tasks === 'object' && !Array.isArray(v.tasks) ? v.tasks : {},
});

/**
 * @param {object} o
 * @param {{ stores: () => unknown, stamp: () => { homeId: string, leaseEpoch: number } | null, current: (stamp: unknown) => boolean, granted: () => boolean, receiveStamp: (stamp: unknown) => { ok: boolean } | Promise<{ ok: boolean }>, data: { safeStorage: any }, storage: { dir: string } }} o.home the home (./momoHome.mjs): ticks run only while it has stores, and a run goes only under the lease epoch its tick began with
 * @param {{ nextRun: (rule: string, after: Date, zone?: string) => Date | null }} o.rules the rule reader (shared/schedule.mjs scheduleRules)
 * @param {{ now: () => number, after: (fn: () => void, ms: number) => () => void }} [o.clock]
 * @param {number} [o.tickMs]
 * @param {(message: string) => void} o.report
 */
export function createMomoScheduler({ home, rules, clock = systemClock, tickMs = TICK_MS, report }) {
  const ledger = new SealedJson({
    file: path.join(home.storage.dir, 'ticks.json'),
    safeStorage: home.data.safeStorage,
    shape: ledgerShape,
    now: clock.now,
  });
  /** @type {TaskSource | null} */
  let source = null;
  /** The tasks as last scheduled, by id: a task whose rule changed is added again. @type {Map<string, string>} */
  const scheduled = new Map();
  let lastTickAt = 0;
  /** Whether this start has looked for runs a stop cut off: done on the first tick the home is active, so a Host with no grant reads and makes nothing. */
  let recovered = false;
  /** @type {'off' | 'running'} */
  let state = 'off';
  /** @type {(() => void) | null} */
  let cancel = null;
  let generation = 0;
  /** The run in `source` a task id names, kept by the latest sync. @type {Map<string, MomoTask>} */
  const tasks = new Map();
  /** What else the Host's clock drives (the day, ./momoDaily.mjs), looked at after the tasks at every tick. @type {(() => Promise<unknown>)[]} */
  const hooks = [];
  /** A run, and each effect of one, goes on only while the lease it began under is still the running home's, the grant is live and the newest-lease sink still takes it: anything less (no lease at all included) is a no. @param {{ homeId: string, leaseEpoch: number } | null} mine */
  const live = async (mine) => !!mine && home.current(mine) && home.granted() && (await home.receiveStamp(mine)).ok;
  /** The home's lease as the tick in progress began: every run of that tick carries it, and one whose lease has moved on is refused. @type {{ homeId: string, leaseEpoch: number } | null} */
  let tickStamp = null;

  const scheduler = createTickScheduler({
    clock,
    // every outcome is kept: the last one per task is what a restart reads (`since`, and a start with no end)
    record: (outcome) =>
      ledger.change((l) => {
        l.tasks[outcome.id] = {
          dueAt: outcome.dueAt,
          status: outcome.status,
          at: outcome.at,
          ...(outcome.error ? { error: outcome.error } : {}),
        };
      }),
    report: (id, error) => report(`MoMo's task ${id}: ${describeError(error)}`),
  });

  /** The last outcome kept for a task, or null. @param {string} id */
  const kept = (id) => {
    try {
      return ledger.read().tasks[id] ?? null;
    } catch {
      return null;
    }
  };

  /** Bring the scheduler to the tasks the source lists now. */
  async function sync() {
    const listed = source ? (await source.list()).filter((t) => t.status === 'ACTIVE') : [];
    const ids = new Set(listed.map((t) => t.id));
    for (const id of [...scheduled.keys()])
      if (!ids.has(id)) {
        scheduler.remove(id);
        scheduled.delete(id);
        tasks.delete(id);
      }
    for (const task of listed) {
      tasks.set(task.id, task);
      const signature = `${task.rrule}\n${task.zone ?? ''}\n${task.schedule_from ?? 0}`;
      if (scheduled.get(task.id) === signature) continue;
      // a task changed while this Host runs is a new schedule from now; one found when the Host starts goes on after the last time it handled
      const changed = scheduled.has(task.id);
      scheduled.set(task.id, signature);
      const since = (changed ? 0 : Math.max(task.schedule_from ?? 0, kept(task.id)?.dueAt ?? 0)) || clock.now();
      scheduler.add({
        id: task.id,
        since,
        next: (after) => rules.nextRun(task.rrule, new Date(after), task.zone)?.getTime() ?? null,
        run: async () => {
          const current = /** @type {MomoTask} */ (tasks.get(task.id));
          const mine = tickStamp;
          // a home that moved while this was due runs nothing: the new home owns the schedule
          if (!(await live(mine))) throw new TaskSkipped('MoMo moved to another machine, so this time was left to its new home.');
          try {
            return await /** @type {TaskSource} */ (source).run(current, {
              stamp: mine,
              live: () => live(mine),
            });
          } catch (error) {
            if (error instanceof RunSkipped) throw new TaskSkipped(error.reason);
            await Promise.resolve(source?.failed?.(current, error)).catch((e) =>
              report(`MoMo's task ${task.id} could not be told of its failure: ${describeError(e)}`),
            );
            throw error;
          }
        },
      });
    }
  }

  /** The hooks run after the tasks whatever the tasks did. */
  async function afterTasks() {
    for (const hook of hooks) await hook().catch((error) => report(`MoMo's day failed: ${describeError(error)}`));
  }

  const api = {
    /** Something else the Host's clock drives, looked at after the tasks at every tick; a failing hook is reported and the others still run. @param {() => Promise<unknown>} hook */
    addTickHook(hook) {
      hooks.push(hook);
    },
    /** The layer above gives what lists and runs the tasks (H3b); none given, nothing is scheduled. @param {TaskSource | null} next */
    setSource(next) {
      source = next;
    },
    /**
     * A tick: nothing while the home has no stores (no live grant, or no active home), else the tasks as listed now and
     * what is due. Returns what ran, or null when it did nothing.
     */
    async tick() {
      if (!home.stores()) return null;
      if (!recovered) {
        await api.recover();
        recovered = true;
      }
      lastTickAt = clock.now();
      tickStamp = home.stamp();
      try {
        await sync();
      } catch (error) {
        report(`MoMo's tasks could not be listed: ${describeError(error)}`);
        await afterTasks();
        return null;
      }
      try {
        return await scheduler.tick();
      } finally {
        await afterTasks();
      }
    },
    /**
     * Runs a stop cut off, as the ledger holds them: each one is closed as "Didn't finish"; the source is told, with the list or none, so it looks at its own open runs too. Done once, before
     * the first tick, so a due time that was started is never run again.
     * @returns {Promise<{ id: string, dueAt: number }[]>}
     */
    async recover() {
      /** @type {{ id: string, dueAt: number }[]} */
      const cut = [];
      let snapshot;
      try {
        snapshot = ledger.read().tasks;
      } catch (error) {
        report(`MoMo's task record could not be read: ${describeError(error)}`);
        return cut;
      }
      for (const [id, e] of Object.entries(snapshot)) if (e?.status === 'started') cut.push({ id, dueAt: e.dueAt });
      if (cut.length)
        await ledger.change((l) => {
          for (const { id } of cut) l.tasks[id] = { ...l.tasks[id], status: 'didnt-finish', at: clock.now(), error: STOPPED };
        });
      // the source looks at its own open runs whether or not a start was cut off here: a run it started goes on in its chat after its start was recorded as run
      await Promise.resolve(source?.interrupted?.(cut)).catch((error) =>
        report(`MoMo's cut-off runs could not be handed on: ${describeError(error)}`),
      );
      return cut;
    },
    /** Tick every `tickMs` until `stop()`; what a stop cut off is looked for on the first tick the home is active. A second start replaces the first. */
    start() {
      const mine = ++generation;
      cancel?.();
      state = 'running';
      recovered = false;
      const again = () => {
        cancel = clock.after(
          () =>
            void api
              .tick()
              .catch((error) => report(`MoMo's tick failed: ${describeError(error)}`))
              .finally(() => generation === mine && again()),
          tickMs,
        );
      };
      again();
    },
    stop() {
      generation++;
      cancel?.();
      cancel = null;
      state = 'off';
    },
    /** What `host.momoStatus` says of it. */
    status() {
      return { state, active: !!home.stores(), lastTickAt, tasks: scheduler.list().length };
    },
  };
  return api;
}
