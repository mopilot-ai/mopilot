// How a MoMo routine's run ends (#2139, the base of routines.cjs): a finished routine tells MoMo's main chat one paragraph (routineReport.cjs); a run waiting for an approval shows as MoMo's "needs you" notice (the approval card is in the run's chat); a run given up on (the turn went quiet or ran too long) is stopped, its approvals denied, and that said; one cut short (MoPilot or the harness quit) says so. A run's chat is archived once its run ended and is deleted when MoMo stops keeping the run (30 days). Each MoPilot handles only the runs it started: another one sharing MoMo's folder leaves them alone while it runs (its pid and start time, as fileLock.cjs judges an owner).
const { onePara } = require('../../shared/momoRoutine.mjs');
const { processStart } = require('../platform/processIdentity.cjs');
const { ownProcess, pidAlive, START_SLACK } = require('../gateway/fileLock.cjs');

/** A run whose chat sat idle this long without its turn finishing (a message held, a lost finish) is over. */
const IDLE_MS = 15 * 60_000;
/** A run still going after this long is given up on: its chat is stopped. */
const MAX_RUN_MS = 2 * 3600_000;
/** A run's chat is deleted a day before MoMo stops keeping the run (30 days), so no chat outlives its record. */
const CHAT_KEEP_MS = 29 * 86_400_000;
const BUSY = new Set(['running', 'awaitingUser']);

/** Whether the MoPilot that recorded `by` still runs: its pid is alive and started when it said (no reused pid). */
async function ownerAlive(/** @type {{ pid: number, started: number }} */ by, startOf = processStart) {
  if (!pidAlive(by.pid)) return false;
  const started = await startOf(by.pid);
  return started === null || Math.abs(started - by.started) <= START_SLACK;
}

class RoutineRuns {
  /**
   * @param {{ routines: InstanceType<typeof import('./routineStore.cjs').RoutineStore>,
   *   report: (r: { name: string, completed: boolean, text: string }) => Promise<boolean>,
   *   sessions: { has: (id: string) => boolean, get: (id: string) => any, patch: (id: string, p: object) => unknown },
   *   stopChat: (chatId: string) => Promise<unknown> | unknown, archiveChat?: (chatId: string) => Promise<unknown> | unknown,
   *   discardChat?: (chatId: string) => Promise<unknown> | unknown,
   *   now?: () => number,
   *   process?: { by: { pid: number, started: number } | Promise<{ pid: number, started: number }>, alive: (by: { pid: number, started: number }) => Promise<boolean> },
   *   [key: string]: any }} o
   *   the stores and session store; stopChat: stop a chat's turn and deny its pending approvals (ChatController); archiveChat,
   *   discardChat: archive or delete a run's chat; report: tell MoMo's main chat how a run ended (routineReport.cjs); and this
   *   MoPilot (and whether another one runs)
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.proc = o.process ?? { by: ownProcess(), alive: ownerAlive };
    /** the chats of the runs this MoPilot started and hasn't ended */
    this.mine = new Set();
  }

  /**
   * A run this MoPilot started; null (nothing recorded) when the day's routine runs reached `limit` meanwhile.
   * @param {{ chatId: string, taskId: string, kind: string, due: number }} run @param {{ limit?: number }} [o]
   */
  async begin(run, { limit } = {}) {
    const entry = await this.o.routines.beginRun({ ...run, by: await this.proc.by }, { limit });
    if (entry) this.mine.add(run.chatId);
    return entry;
  }

  /** A run that didn't get going: closed with nothing posted (the scheduler keeps why). */
  async close(/** @type {string} */ chatId) {
    this.mine.delete(chatId);
    await this.o.routines.endRun(chatId, 'failed');
  }

  /** A turn finished (ChatController.onFinished, for every chat): one of this MoPilot's runs reports or closes. */
  async finished(/** @type {{ chatId: string, text?: string | null, completed?: boolean }} */ e) {
    if (this.mine.has(e.chatId)) await this.end(e.chatId, !!e.completed, e.text ?? '');
  }

  /** The harness quit (ChatController.onCrash, for every chat). */
  async crashed(/** @type {string} */ chatId) {
    if (this.mine.has(chatId)) await this.end(chatId, false);
  }

  /**
   * End a run: its paragraph goes to MoMo's main chat, or why it didn't finish. Its chat is archived after.
   * @param {string} chatId @param {boolean} completed @param {string} [text]
   * @param {'completed' | 'failed' | 'interrupted'} [outcome] @param {string} [why] what MoMo's chat is told of a run that didn't finish
   */
  async end(chatId, completed, text = '', outcome = completed ? 'completed' : 'failed', why = 'The run didn’t finish.') {
    this.mine.delete(chatId);
    const run = await this.o.routines.endRun(chatId, outcome);
    if (!run) return;
    const paragraph = onePara(text);
    await this.o.report({
      name: this.o.routines.get(run.taskId)?.name ?? 'A routine',
      completed,
      text: completed ? paragraph || 'Finished with nothing to say.' : why,
    });
    // out of the way once its result is told
    await this.o.archiveChat?.(chatId);
  }

  /** Give up on a run: its turn is stopped and its approvals denied, then it ends saying why. */
  async giveUp(/** @type {string} */ chatId, /** @type {string} */ why) {
    // no longer this MoPilot's run before it is stopped: a stop that finishes the turn doesn't end it a second time
    this.mine.delete(chatId);
    await this.o.stopChat(chatId);
    await this.end(chatId, false, '', 'failed', why);
  }

  /**
   * The open runs against their chats, on every scheduler check: one gone quiet or on too long is given up on; one whose
   * MoPilot is gone ends as cut short.
   * Another MoPilot's runs are left to it while it runs. Then the chats of runs MoMo is about to forget are deleted.
   */
  async check() {
    const now = this.now();
    for (const run of this.o.routines.openRuns()) {
      if (!this.mine.has(run.chatId)) {
        // another MoPilot's while it runs; this one's from before a restart, or a closed one's, were cut short
        const by = /** @type {any} */ (run.by);
        const me = await this.proc.by;
        const other = by && typeof by.pid === 'number' && (by.pid !== me.pid || by.started !== me.started);
        if (other && (await this.proc.alive(by))) continue;
        await this.end(run.chatId, false, '', 'interrupted', 'MoPilot closed during the run.');
        continue;
      }
      const session = this.o.sessions.has(run.chatId) ? this.o.sessions.get(run.chatId) : null;
      if (!session) {
        await this.end(run.chatId, false, '', 'failed', 'The run stopped without finishing.');
        continue;
      }
      if (!BUSY.has(session.turn) && now - run.startedAt >= IDLE_MS) {
        await this.giveUp(run.chatId, 'The run stopped without finishing.');
        continue;
      }
      if (now - run.startedAt >= MAX_RUN_MS) {
        await this.giveUp(run.chatId, 'The run took too long, so it was stopped.');
        continue;
      }
    }
    for (const run of this.o.routines.endedBefore(now - CHAT_KEEP_MS)) {
      await this.o.discardChat?.(run.chatId);
      await this.o.routines.markDiscarded(run.chatId);
    }
  }
}

module.exports = { RoutineRuns, ownerAlive, IDLE_MS, MAX_RUN_MS, CHAT_KEEP_MS };
