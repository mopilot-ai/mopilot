// MoMo's routines in the app's one scheduler (#2139): the scheduler lists the user's scheduled tasks and MoMo's beside them, and each MoMo task's run, check and failure go to MoMo's routines service, never to the scheduled-task runner, the Scheduled page or its notifications. MoMo's tasks have their own gate (the "run schedules" setting doesn't stop them), and the shared run ledger gets only a fixed code for them: what went wrong goes to MoMo's chat.
const { RunSkipped } = require('../platform/scheduler.cjs');
const { ROUTINE, isMomoTaskId } = require('../../shared/momoRoutine.mjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @typedef {{
 *   list: () => Promise<any[]>,
 *   validate: (task: any) => Promise<any | null>,
 *   run: (task: any) => Promise<string>,
 *   failed?: (task: any, error: unknown) => void,
 * }} MomoTaskSource MoMo's routines service as the scheduler sees it (electron/momo/routines.cjs)
 */

const isMomoTask = (/** @type {any} */ t) => isMomoTaskId(t?.id) && t.kind === ROUTINE;

/** What the shared run ledger records of a MoMo run that failed: a code, never the error's text. */
const MOMO_FAILED = 'run-failed';

/**
 * The scheduler's list, validate, run, notify and skipped with MoMo's tasks beside the user's. `source()` is read at
 * every call: null while MoMo's service isn't up, and then MoMo has no tasks. A MoMo task is one MoMo's service
 * listed in the latest check; the user's tasks never reach MoMo's service, whatever their id or kind.
 * @param {{ list: () => Promise<any[]>, validate: (task: any) => Promise<any>, run: (task: any) => Promise<string>,
 *   notify?: (chatId: string | null, task: any, o: object) => void, skipped?: (task: any, due: number, reason: string) => void }} base
 * @param {() => MomoTaskSource | null | undefined} source
 */
function withMomoTasks(base, source) {
  /** the MoMo tasks the latest check listed */
  let listed = new Set();
  const ours = (/** @type {any} */ task) => isMomoTask(task) && listed.has(String(task.id));
  return {
    list: async () => {
      const tasks = await base.list();
      const src = source();
      let momo = [];
      try {
        momo = src ? (await src.list()).filter(isMomoTask) : [];
      } catch (error) {
        // the user's own tasks still run
        noteIgnored("list MoMo's routines for the scheduler", error);
      }
      listed = new Set(momo.map((t) => String(t.id)));
      return [...tasks, ...momo];
    },
    validate: async (/** @type {any} */ task) => {
      if (!ours(task)) return base.validate(task);
      const current = await source()?.validate(task);
      if (!current) throw new Error(`MoMo's routine "${task.id}" no longer exists.`);
      return current;
    },
    /** Tasks the "run schedules" setting doesn't gate: MoMo's own. */
    independent: ours,
    run: async (/** @type {any} */ task) => {
      if (!ours(task)) return base.run(task);
      const src = source();
      // MoMo's service went away between the check and the run: the time is kept as skipped
      if (!src) throw new RunSkipped('not-allowed');
      try {
        return await src.run(task);
      } catch (error) {
        if (error instanceof RunSkipped) throw error;
        // MoMo's chat is told what went wrong; the shared ledger and the scheduler's log get a code
        await src.failed?.(task, error);
        throw new Error(MOMO_FAILED);
      }
    },
    // MoMo's runs make no app notification: MoMo's chat is told of a failed one
    notify: (/** @type {string | null} */ chatId, /** @type {any} */ task, /** @type {object} */ o) => {
      if (!ours(task)) return base.notify?.(chatId, task, o);
    },
    // a skipped time of MoMo's says nothing
    skipped: (/** @type {any} */ task, /** @type {number} */ due, /** @type {string} */ reason) => {
      if (!ours(task)) return base.skipped?.(task, due, reason);
    },
  };
}

module.exports = { withMomoTasks, isMomoTask, MOMO_FAILED };
