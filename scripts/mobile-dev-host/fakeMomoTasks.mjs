// DEV ONLY: the four-tab Tasks list (M0a) as the dev host's fake Mac answers it: the Mac's own derivation (electron/momo/tasksPanel.cjs) and its own marks (electron/momo/taskMarks.cjs, over the in-memory storage seam) over fake data that gives every tab rows: a loop due soon and a card and a run going and runs that did not finish or wait for review (Active), loops not due soon (Up next), the fake routines (Scheduled) and a loop and a run closed (Resolved). `fail` makes the read fail, as a Mac that could not read its tasks.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RemoteError } = require('../../electron/remote/serviceErrors.cjs');
const { deriveTaskPanel } = require('../../electron/momo/tasksPanel.cjs');
const { createTaskMarks, memoryStorage } = require('../../electron/momo/taskMarks.cjs');
const { nextRun } = require('../../electron/platform/scheduler.cjs');
const H = 3_600_000;

/**
 * @param {object} o
 * @param {() => number} o.now
 * @param {{ id: string, name: string, schedule: string, paused: boolean }[]} o.routines the fake routines (the Scheduled tab)
 * @param {any[]} o.loops the fake open loops (one due in two days, one snoozed, as the classic list has them)
 * @param {() => boolean} o.paused whether MoMo is paused (Pause all)
 * @param {() => boolean} o.failing whether the next read fails
 * @param {() => (import('../../electron/momo/tasksPanel.cjs').BriefRow | null)} o.brief the morning brief's Scheduled row (fakeMomoBrief.mjs), null while it is off
 * @param {() => boolean} o.empty whether the Mac has no tasks at all, so every tab shows its empty line
 * @param {() => Promise<any[]>} o.cards the approval cards waiting in MoMo's chat
 * @param {(area: 'memory') => void} o.changed
 */
export function createFakeTaskPanel({ now, routines, loops, paused, failing, empty, cards, changed, brief }) {
  const marks = createTaskMarks({ storage: memoryStorage({ now }), now });
  const runs = [
    { chatId: 'dev-run-1', taskId: 'r1', startedAt: now() - 5 * 60_000 },
    { chatId: 'dev-run-2', taskId: 'r1', startedAt: now() - 3 * H, endedAt: now() - 2 * H, outcome: 'completed' },
    { chatId: 'dev-run-3', taskId: 'r2', startedAt: now() - 6 * H, endedAt: now() - 5 * H, outcome: 'stopped' },
    { chatId: 'dev-run-4', taskId: 'r1', startedAt: now() - 30 * H, endedAt: now() - 29 * H, outcome: 'completed' },
  ];
  // one run was marked done earlier, so Resolved has it
  const first = marks.mark('run:dev-run-4', 'done');
  const extra = [
    {
      id: 'tl-soon',
      text: 'Send the invoice',
      quote: 'I will send the invoice today',
      state: 'open',
      saidAt: now() - H,
      dueAt: now() + 3 * H,
    },
    { id: 'tl-open', text: 'Plan the offsite', quote: 'plan the offsite someday', state: 'open', saidAt: now() - 26 * H },
    {
      id: 'tl-closed',
      text: 'Book the dentist',
      quote: 'book the dentist',
      state: 'done',
      saidAt: now() - 50 * H,
      closedAt: now() - 4 * H,
    },
  ];
  return {
    async list() {
      if (failing()) throw new RemoteError('failed', 'MoMo could not read its tasks.');
      await first;
      if (empty()) return { v: 2, tasks: [], paused: paused(), now: now() };
      const tasks = deriveTaskPanel({
        runs,
        routineName: (/** @type {string} */ id) => routines.find((r) => r.id === id)?.name,
        routines: routines.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.paused ? 'PAUSED' : 'ACTIVE',
          rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30',
        })),
        nextRun: (/** @type {string} */ rrule, /** @type {number} */ after) => nextRun(rrule, new Date(after)),
        loops: [...loops, ...extra],
        cards: (await cards()).map((c) => ({
          id: c.id,
          params: { momo: { summary: c.title, source: 'Mail' } },
          channel: c.channel ?? null,
          chatId: c.chatId,
        })),
        marks: marks.list(),
        now: now(),
        brief: brief(),
      });
      // as the Mac's remote ops answer: a phone is told the channel of a card, never the chat it waits in
      return { v: 2, tasks: tasks.map((/** @type {any} */ { chatId: _chat, ...task }) => task), paused: paused(), now: now() };
    },
    /** The user's mark, or its Undo, as the Mac takes it (a run the fake does not have is gone). */
    async mark(/** @type {string} */ taskId, /** @type {string} */ mark, /** @type {string | undefined} */ undoToken = undefined) {
      if (!runs.some((r) => `run:${r.chatId}` === taskId)) throw new RemoteError('gone', 'That task is gone.');
      try {
        const done = await marks.mark(taskId, mark, undoToken);
        changed('memory');
        return done;
      } catch (error) {
        throw new RemoteError('failed', /** @type {Error} */ (error).message);
      }
    },
  };
}
