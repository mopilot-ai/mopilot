// MoMo's routines service (#2139): the MoMo tasks the app's scheduler runs (schedulerTasks.cjs). Each run is a turn in a fresh MoMo background chat started isolated (no harness memory, no user instructions, no built-in file or shell tools) on the MoMo's one brain, unattended and never auto-approving; how a run ends is routineRuns.cjs's. A time that is skipped (quiet hours, the daily limit, paused, missed) starts nothing and says nothing. While MoMo isn't allowed for the account nothing is listed, read or written, and runs under way are stopped. Harness-independent: the brain names any harness; its chat is started by the injected isolated start.
const { RunSkipped, rules } = require('../platform/scheduler.cjs');
const { ROUTINE, routineSettings, runDecision, LIMITS } = require('../../shared/momoRoutine.mjs');
const { RoutineRuns } = require('./routineRuns.cjs');
const { authoredOr } = require('../session/authoredInput.cjs');
const { sourcesText } = require('./sources/hub.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { markedText } = require('../../shared/modelFraming.mjs');

/** How an unattended MoMo run's chat is marked (SessionState.scheduled): it may not control apps, and approvals wait. */
const UNATTENDED = Object.freeze({ unattended: true, computer: false, onApproval: 'wait' });
/** Why a run the user started (Run now) did not start, in the words the Tasks panel shows. */
const NOT_STARTED = Object.freeze({
  'not-allowed': 'MoMo is not available for this account.',
  'not-approved': 'That routine isn’t there any more.',
  'at-limit': 'Its harness is at its usage limit. Try again later.',
  limit: 'It didn’t start. Try again.',
});
/** What MoMo's chat is told of a routine's run stopped because the user removed the routine. */
const REMOVED_TEXT = 'The routine was removed, so the run was stopped.';
/** How a run's chat is started: MoMo's isolated start (as its main chat), with the harness's own file and shell tools off too. */
const ISOLATION = Object.freeze({ harnessMemory: false, userInstructions: false, builtinTools: false });

/** The nudge check's task (nudges.cjs): listed while there is an open loop, at 7 past every hour. */
const NUDGE_TASK = Object.freeze({ id: 'momo.nudges', rrule: 'FREQ=HOURLY;BYMINUTE=7;BYSECOND=0' });

/** The first message of a routine's run. */
function routinePrompt(/** @type {{ name: string, prompt: string, sources?: string[] }} */ r) {
  const reads = sourcesText(r.sources);
  return [
    markedText('Routine run', `This is your routine "${r.name}", run on its schedule with nobody watching.`),
    r.prompt,
    // the sources hub holds the run to them (sources/hub.cjs setScope)
    reads ? `It may read only ${reads}.` : 'It reads none of the user’s sources.',
    'Do only what it asks. Anything that changes or sends something waits for the user’s approval: ask, don’t work around it.',
    'End with one short paragraph saying what you found or did.',
  ].join('\n\n');
}

/**
 * @typedef {object} RoutinesOptions what main gives MoMo's routines service
 * @property {InstanceType<typeof import('./routineStore.cjs').RoutineStore>} routines
 * @property {(r: { name: string, completed: boolean, text: string }) => Promise<boolean>} report tell MoMo's main chat how a run
 *   ended, or why it didn't start (routineReport.cjs)
 * @property {() => boolean} allowed MoMo is on for the signed-in account (access.cjs momoAllowed)
 * @property {() => any} prefs the app's prefs (prefs.momo.routines, prefs.momo.brain, prefs.momo.paused)
 * @property {() => any} mainBrain MoMo's main brain ({harness, account, model}) or null
 * @property {(kind: string, o: { unattended: boolean }) => Promise<boolean>} usable the harness can run now
 * @property {(brain: any) => { go: any } | { held: string }} [atLimit] the at-limit rule for the brain
 *   (brainLimit.cjs): run on it (or the next account), or skip saying why
 * @property {(brain: any, meta: { momo: 'routine', routineId: string, isolation: typeof ISOLATION }) => Promise<string>} startChat
 *   a fresh MoMo background chat on the brain through MoMo's isolated start (MoMo's workspace, no project, harness memory
 *   and user instructions off, built-in file and shell tools off, a mode that asks before any change), tagged `meta`
 * @property {(chatId: string) => unknown} [discardChat] delete a run's chat (one that didn't go ahead, or past keeping)
 * @property {(chatId: string) => unknown} [archiveChat] archive a run's chat once its run ended
 * @property {(chatId: string) => unknown} stopChat stop a chat's turn and deny its pending approvals
 * @property {(chatId: string, item: object) => Promise<any>} send the first message, through the ChatController
 * @property {(chatId: string, text: string, show: { by: string, title: string, body?: string | null }) => object} [authored]
 *   that message as an input no human wrote, with how windows show it (session/authoredInput.cjs)
 * @property {(taskId: string) => unknown} [forget] drop a removed routine's run history (RunLedger.forget, live.runLedger)
 * @property {{ has: (id: string) => boolean, get: (id: string) => any, patch: (id: string, p: object) => unknown }} sessions
 * @property {{ active: () => boolean, run: () => Promise<string> }} [nudges] the nudge check (nudges.cjs): a task of its own,
 *   past the routines' approval and run limit (its gate is its own: nudgeGate.cjs)
 * @property {{ active: () => boolean, task: () => { id: string, name: string, rrule: string }, run: () => Promise<string>,
 *   failed: (error: unknown) => unknown }} [brief] the morning brief (brief.cjs): a task of its own like the nudge check, behind prefs.momo.brief
 * @property {() => number} [now]
 * @property {any} [process] this MoPilot, and whether another one still runs (routineRuns.cjs)
 */

class MomoRoutines extends RoutineRuns {
  /** @type {Map<string, string>} each routine's last start failure that was told, until a run of it starts: the same one isn't told again */
  toldFailures = new Map();

  settings() {
    return routineSettings(this.o.prefs());
  }

  /**
   * MoMo's tasks for the scheduler (none while MoMo isn't allowed); each check also looks at the runs under way.
   */
  async list() {
    if (!this.o.allowed()) return [];
    await this.check();
    return this.tasks();
  }

  /** The tasks, read only. */
  tasks() {
    const settings = this.settings();
    if (settings.proactivity === 'off') return [];
    // the brain the run will likely take (the ledger's note of it); the run decides
    const harness = this.o.mainBrain()?.harness;
    const nudges = this.o.nudges?.active()
      ? [
          {
            id: NUDGE_TASK.id,
            kind: ROUTINE,
            name: 'Nudges',
            status: 'ACTIVE',
            rrule: NUDGE_TASK.rrule,
            created_at: 0,
            schedule_from: 0,
            harness,
          },
        ]
      : [];
    const brief = this.o.brief?.active()
      ? [{ ...this.o.brief.task(), kind: ROUTINE, status: 'ACTIVE', created_at: 0, schedule_from: 0, harness }]
      : [];
    const routines = this.o.routines.list().map((r) => ({
      id: r.id,
      kind: ROUTINE,
      name: r.name,
      // one MoMo proposed doesn't run before the user approves it
      status: r.approved ? r.status : 'PAUSED',
      rrule: r.rrule,
      created_at: r.createdAt,
      schedule_from: r.scheduleFrom,
      harness,
    }));
    return [...nudges, ...brief, ...routines];
  }

  /** The task as it is now, or null when it is gone or MoMo isn't allowed (the scheduler checks before a claim). Read only. */
  async validate(/** @type {any} */ task) {
    if (!this.o.allowed()) return null;
    return this.tasks().find((t) => t.id === task.id) ?? null;
  }

  /** The brain that runs: MoMo's one brain; throws when it can't run now. */
  async brain() {
    const main = this.o.mainBrain();
    if (main && (await this.o.usable(main.harness, { unattended: true }))) return { brain: main };
    throw new Error('No harness can run MoMo’s routines now: sign in or install one.');
  }

  /**
   * Start a run: resolves to its chat, or throws RunSkipped (nothing starts, nothing is said) or an error (told by failed()).
   */
  async run(/** @type {any} */ task) {
    if (task.id === NUDGE_TASK.id && this.o.nudges) return this.o.nudges.run();
    if (this.o.brief && task.id === this.o.brief.task().id) return this.o.brief.run();
    return this.start(task, false);
  }

  /**
   * The user's Run now on a routine (Tasks › Scheduled): one run through the same path as the scheduler's, at once. It skips
   * quiet hours, "Pause all" and the day's run limit (the user asked for it, and it counts toward none of them), and still
   * needs MoMo allowed, the routine approved and a harness that can run. One routine runs one at a time. Resolves to the
   * run's chat; throws an Error that says why nothing started.
   * @param {string} id
   */
  async runNow(id) {
    if (!this.o.allowed()) throw Object.assign(new Error(NOT_STARTED['not-allowed']), { code: 'not_allowed' });
    const routine = this.o.routines.get(id);
    if (!routine?.approved) throw new Error(NOT_STARTED['not-approved']);
    if (this.o.routines.openRuns().some((r) => r.taskId === id)) throw new Error('It’s already running.');
    return this.start({ id, kind: ROUTINE, rrule: routine.rrule }, true);
  }

  /**
   * One run of a routine: the scheduler's (`manual` false: its time must pass runDecision, and a skip says nothing) or the
   * user's Run now (`manual`: nothing skips it; why it didn't start is an Error).
   * @param {{ id: string, kind: string, rrule: string }} task @param {boolean} manual
   */
  async start(task, manual) {
    const settings = this.settings();
    const at = this.now();
    const due = rules.lastRun(task.rrule, at) ?? at;
    const skip = (/** @type {keyof typeof NOT_STARTED} */ reason) => (manual ? new Error(NOT_STARTED[reason]) : new RunSkipped(reason));
    if (!manual) {
      const routine = this.o.routines.get(task.id);
      const decision = runDecision({
        at,
        settings,
        allowed: this.o.allowed(),
        runsToday: this.o.routines.runsOn(at),
        // a routine removed since it was listed is no longer approved
        approved: !!routine?.approved,
      });
      if (!decision.ok) throw new RunSkipped(decision.reason);
    }
    // the brain that runs; one known to be at its limit: Skip this run (or Pause) starts nothing, Next account moves to
    // the next one
    const picked = await this.brain();
    const limit = this.o.atLimit?.(picked.brain) ?? { go: picked.brain };
    if ('held' in limit) throw skip('at-limit');
    const brain = limit.go;
    /** @type {string | null} a chat started that isn't a run (yet) */
    let chatId = null;
    /** @type {string | null} the run's chat, once it is one */
    let runId = null;
    try {
      const id = await this.o.startChat(brain, { momo: 'routine', routineId: task.id, isolation: ISOLATION });
      chatId = id;
      // MoMo was turned off while the harness started: nothing is sent or written, and the chat goes
      if (!this.o.allowed()) throw skip('not-allowed');
      const run = { chatId: id, taskId: task.id, kind: task.kind, due };
      // the day's limit, counted again under the lock now that the chat exists
      if (!(await this.begin(run, manual ? {} : { limit: LIMITS[settings.proactivity].runs }))) throw skip('limit');
      chatId = null;
      runId = id;
      // removed while its chat started: it doesn't run, and its chat goes (one removed from here on is stopped by remove())
      // and as it is now: an edit while its chat started is what the run is told (the sources hub holds it to the same)
      const current = this.o.routines.get(task.id);
      if (!current?.approved) {
        chatId = id;
        throw skip('not-approved');
      }
      this.o.sessions.patch(id, { scheduled: UNATTENDED });
      const item = authoredOr(this.o.authored, id, routinePrompt(current), {
        by: 'momo',
        title: `Routine “${current.name}”`,
        body: current.prompt,
      });
      const sent = await this.o.send(id, item);
      if (sent?.started === false && !sent.held && !sent.discarded)
        throw new Error(`The run’s message didn’t start: ${sent.error ?? 'the harness refused it'}`);
      this.toldFailures.delete(task.id);
      return id;
    } catch (error) {
      // a chat that never became a run goes; a run that didn't get going closes
      if (chatId) await this.o.discardChat?.(chatId);
      if (runId) await this.close(runId);
      throw error;
    }
  }

  /**
   * A run failed to start (schedulerTasks.cjs): MoMo's main chat is told what went wrong, while allowed. A routine that
   * keeps failing the same way is told once, until one of its runs starts (an hourly routine wakes the chat once, not hourly).
   */
  async failed(/** @type {any} */ task, /** @type {unknown} */ error) {
    // a nudge check that failed tells nobody: the next hour's check tries again
    if (task.id === NUDGE_TASK.id) return noteIgnored("run MoMo's nudge check", error);
    // a brief that could not start says why on its Scheduled row, with Try again: MoMo's chat is not woken for it
    if (this.o.brief && task.id === this.o.brief.task().id) return this.o.brief.failed(error);
    if (!this.o.allowed()) return;
    const text = String(/** @type {any} */ (error)?.message ?? error);
    if (this.toldFailures.get(task.id) === text) return;
    // told once it was: one the chat could not be given (MoMo paused, no main chat) is tried again next time
    if (await this.o.report({ name: task.name, completed: false, text })) this.toldFailures.set(task.id, text);
  }

  /** MoMo was turned off for the account (access.cjs onChange): this MoPilot's runs under way are stopped; nothing is written. */
  async revoked() {
    const chats = [...this.mine];
    this.mine.clear();
    for (const chatId of chats) await this.o.stopChat(chatId);
  }

  /**
   * A routine MoMo proposes (its momo_routine_propose tool, or a starter routine picked in setup): kept unapproved until
   * the user approves it in Settings › MoMo › Routines. One already waiting under the same name is the answer. With
   * `starter`, null when that starter was proposed before (routineStore.cjs add).
   * @param {{ name?: unknown, prompt?: unknown, rrule?: unknown, sources?: unknown }} input
   * @param {{ starter?: string }} [o]
   */
  async propose(input, { starter } = {}) {
    if (!this.o.allowed()) throw Object.assign(new Error('MoMo is not available for this account.'), { code: 'not_allowed' });
    return this.o.routines.add(input, { approved: false, ...(starter !== undefined ? { starter } : {}) });
  }

  /**
   * Remove a routine (Decline on a proposal, Remove in the list): this MoPilot's runs of it under way are stopped, then
   * its record and its run history in the shared ledger go. Whether it was there.
   */
  async remove(/** @type {string} */ id) {
    for (const run of this.o.routines.openRuns())
      if (run.taskId === id && this.mine.has(run.chatId)) await this.giveUp(run.chatId, REMOVED_TEXT);
    const removed = await this.o.routines.remove(id);
    if (removed) await this.o.forget?.(id);
    return removed;
  }
}

/** @param {RoutinesOptions} o */
const createMomoRoutines = (o) => new MomoRoutines(o);

module.exports = {
  NUDGE_TASK,
  createMomoRoutines,
  MomoRoutines,
  routinePrompt,
  UNATTENDED,
  ISOLATION,
  REMOVED_TEXT,
};
