// IPC for Settings › MoMo › Routines (#2139): the routines MoMo proposed (each with what it will do and when, so an approval is never blind), approving one, declining one, and the user's routines: every approved one listed to pause, resume, edit (name, what it does, schedule, the sources it reads) or remove. Every call is refused unless MoMo is allowed for the account; windows hear momoRoutines:changed after a change.
const { rules } = require('../platform/scheduler.cjs');
const { routineRule, ruleParts, RoutineError } = require('../../shared/momoRoutine.mjs');
const { sourcesText, SOURCE_IDS, LABELS } = require('./sources/hub.cjs');

const notAllowed = () => Object.assign(new Error('MoMo is not available for this account.'), { code: 'not_allowed' });

/**
 * Every routine waiting for the user's approval, whatever the proactivity level and however many: what it will do (its
 * prompt) and when (its schedule in words), so an approval is never blind.
 * @param {any[]} routines RoutineStore.list()
 */
function proposalsOf(routines) {
  return routines
    .filter((r) => !r.approved)
    .map((r) => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      schedule: rules.describe(r.rrule),
      sources: sourcesText(r.sources),
      rev: r.rev ?? 0,
    }));
}

/**
 * Every routine the user approved, paused ones too and however many: what it does, when (in words, and as a time and
 * days when it is one, for the edit form), what it reads, and whether it is paused.
 * @param {any[]} routines RoutineStore.list()
 */
function routinesOf(routines) {
  return routines
    .filter((r) => r.approved)
    .map((r) => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      schedule: rules.describe(r.rrule),
      rrule: r.rrule,
      parts: ruleParts(r.rrule),
      sources: r.sources ?? [],
      paused: r.status === 'PAUSED',
    }));
}

/**
 * The user's change to a routine, as the store takes it: only what the form sets, never an approval. A schedule given
 * as a time with days or an RRULE (shared/momoRoutine.mjs routineRule).
 * @param {any} edit
 */
function patchOf(edit) {
  const e = edit && typeof edit === 'object' ? edit : {};
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (e.name !== undefined) patch.name = e.name;
  if (e.prompt !== undefined) patch.prompt = e.prompt;
  if (e.sources !== undefined) patch.sources = e.sources;
  if (typeof e.paused === 'boolean') patch.status = e.paused ? 'PAUSED' : 'ACTIVE';
  if (e.rrule !== undefined || e.time !== undefined) {
    const schedule = routineRule(e);
    if (!schedule.ok) throw new RoutineError(schedule.error, 'bad_args');
    patch.rrule = schedule.rrule;
  }
  return patch;
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ routines: InstanceType<typeof import('./routineStore.cjs').RoutineStore>,
 *   service: InstanceType<typeof import('./routines.cjs').MomoRoutines>, allowed: () => boolean,
 *   broadcast: (channel: string) => void }} o
 * @returns {{ changed: () => void }} `changed`: tell the windows the routines changed (main calls it after a proposal)
 */
function registerRoutinesIpc(ipcMain, { routines, service, allowed, broadcast }) {
  const changed = () => broadcast('momoRoutines:changed');
  /** A handler that runs only while MoMo is allowed. */
  const gated =
    (/** @type {(...args: any[]) => any} */ fn) =>
    (/** @type {unknown} */ _e, /** @type {any[]} */ ...args) => {
      if (allowed() !== true) throw notAllowed();
      return fn(...args);
    };
  ipcMain.handle(
    'momoRoutines:view',
    gated(() => {
      // one read of the routines for both lists, so they agree
      const all = routines.list();
      return {
        proposals: proposalsOf(all),
        routines: routinesOf(all),
        // what a routine may read, as its edit form lists them
        sources: SOURCE_IDS.map((id) => ({ id, label: /** @type {Record<string, string>} */ (LABELS)[id] })),
      };
    }),
  );
  ipcMain.handle(
    'momoRoutines:approve',
    gated(async (id, seen) => {
      // the one place a routine is approved: the user's Approve in Settings (tests/momoRoutineStore.test.ts), of the
      // version it showed: one MoMo changed since is refused, and the list reads it again
      if (typeof seen !== 'number') throw new RoutineError('Approve what was shown: its version is missing.', 'bad_args');
      const routine = await routines.update(String(id), { approved: true }, { seen });
      if (routine) changed();
      return routine;
    }),
  );
  ipcMain.handle(
    'momoRoutines:edit',
    gated(async (id, edit) => {
      // the user's Pause, Resume or Edit: a new schedule or a resume counts from now (routineStore.cjs)
      const routine = await routines.update(String(id), patchOf(edit));
      if (routine) changed();
      return routine;
    }),
  );
  ipcMain.handle(
    'momoRoutines:runNow',
    gated(async (id) => {
      // the user's Run now: a run starts through the scheduler's own path (routines.cjs runNow), or the call says why not
      const chatId = await service.runNow(String(id));
      changed();
      return { chatId };
    }),
  );
  ipcMain.handle(
    'momoRoutines:history',
    gated((id) =>
      // View history: when each run of one routine started and how it ended, newest first; none yet is an empty list
      routines.runsOf(String(id)).map((r) => ({
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        // a run still going has no outcome yet
        outcome: r.endedAt === undefined ? 'running' : (r.outcome ?? 'failed'),
      })),
    ),
  );
  ipcMain.handle(
    'momoRoutines:remove',
    gated(async (id) => {
      // Decline on a proposal, Remove on a routine in the list: its record and run history go
      const removed = await service.remove(String(id));
      if (removed) changed();
      return removed;
    }),
  );
  return { changed };
}

module.exports = { registerRoutinesIpc, proposalsOf, routinesOf, patchOf };
