// IPC for MoMo's Tasks (A1, M0a): momoTasks:list derives the list from the loops, routine runs and waiting cards, read-only; with the `momo.tasksPanel` flag on it is the four tabs' rows (tasksPanel.cjs, v: 2) and momoTasks:mark takes the user's mark on a run (taskMarks.cjs: done, archive, delete, reopen, or an Undo token); both are refused while MoMo is not allowed, as the memory handlers are. A change of the loops or a mark is told to the windows as momoTasks:changed.
const { messageOf } = require('../ignored.cjs');
/** The refusal the memory handlers give (memoryIpc.cjs NOT_ALLOWED, held equal by tests/momoTasks.test.ts), repeated so this module imports nothing that writes to disk. */
const NOT_ALLOWED = Object.freeze({ ok: false, reason: 'not_allowed', error: 'MoMo is not available' });
const { deriveTasks, RUN_SHOWN_MS } = require('./tasks.cjs');
const { deriveTaskPanel, RESOLVED_SHOWN_MS } = require('./tasksPanel.cjs');

const CHANNELS = Object.freeze(['momoTasks:list', 'momoTasks:mark']);

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'removeHandler'>} ipcMain
 * @param {{ loops: { list: () => any[], on: Function, off: Function }, runsSince: (at: number) => any[], routineName: (taskId: string) => string | null | undefined,
 *   cards: () => any[], allowed: () => boolean, broadcast?: ((channel: string) => void) | null, now?: () => number,
 *   panel?: () => boolean, marks?: ReturnType<typeof import('./taskMarks.cjs').createTaskMarks> | null, routines?: () => any[],
 *   nextRun?: (rrule: string, after: number) => Date | null, paused?: () => boolean, brief?: () => import('./tasksPanel.cjs').BriefRow | null }} o
 *   panel: whether `momo.tasksPanel` is on; marks, routines (the approved ones), nextRun, paused: what the four tabs read
 * @returns {() => void} removes the handler
 */
function registerTasksIpc(
  ipcMain,
  {
    loops,
    runsSince,
    routineName,
    cards,
    allowed,
    broadcast = null,
    now = Date.now,
    panel = () => false,
    marks = null,
    routines = () => [],
    nextRun = () => null,
    paused = () => false,
    brief = () => null,
  },
) {
  const changed = () => {
    if (allowed() === true) broadcast?.('momoTasks:changed');
  };
  loops.on('changed', changed);
  ipcMain.handle('momoTasks:list', async () => {
    if (allowed() !== true) return NOT_ALLOWED;
    try {
      const at = now();
      if (panel() === true && marks) {
        const tasks = deriveTaskPanel({
          runs: runsSince(at - RESOLVED_SHOWN_MS),
          routineName,
          routines: routines(),
          nextRun,
          loops: loops.list(),
          cards: cards(),
          marks: marks.list(),
          now: at,
          brief: brief(),
        });
        return { ok: true, v: 2, tasks, paused: paused() === true, now: at };
      }
      const tasks = deriveTasks({
        runs: runsSince(at - RUN_SHOWN_MS),
        routineName,
        loops: loops.list(),
        cards: cards(),
        now: at,
      });
      return { ok: true, tasks, now: at };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });
  ipcMain.handle('momoTasks:mark', async (_e, taskId, mark, undoToken) => {
    if (allowed() !== true) return NOT_ALLOWED;
    if (panel() !== true || !marks) return { ok: false, reason: 'unavailable', error: 'The Tasks panel is off' };
    try {
      const done = await marks.mark(taskId, mark, undoToken);
      broadcast?.('momoTasks:changed');
      // phones hear of a mark apart from a loop's change: they already read the loops on `memory`
      broadcast?.('momoTasks:marked');
      return { ok: true, ...done };
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      return { ok: false, error: messageOf(error), ...(code === 'expired' ? { reason: 'expired' } : {}) };
    }
  });
  return () => {
    loops.off('changed', changed);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerTasksIpc, CHANNELS, NOT_ALLOWED };
