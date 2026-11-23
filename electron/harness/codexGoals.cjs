// The Codex adapter's goals across quit and restart (WP5-4): paused before a thread loads, recorded, recovered at launch.
const { clock } = require('../platform/ports/clock.cjs');
const { CodexConnection } = require('./codexConnection.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { writeAtomic, readStateFile } = require('../platform/fsutil.cjs');

/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter the adapter these methods run on */

class CodexGoals extends CodexConnection {
  /* -- goals across quit and restart (WP5-4) ------------------------- */
  /**
   * Set a goal paused before its thread is loaded: resuming a thread whose goal is active lets the
   * app-server carry on with it by itself. Only when the app-server won't set it on an unloaded
   * thread is the thread resumed first.
   * @this {CodexAdapter}
   */
  async pauseFirst(threadId, /** @type {string | null} */ reason = null) {
    const was = this.goals.get(threadId) ?? 'active';
    // recorded first, so the goal/updated that comes back already reads as paused at quit
    if (reason) this.noteGoal(threadId, { status: 'paused' }, reason);
    let r;
    try {
      try {
        r = await this.request('thread/goal/set', { threadId, status: 'paused' });
      } catch (e) {
        if (this.down || this.leases.has(threadId)) throw e;
        await this.resume(threadId);
        r = await this.request('thread/goal/set', { threadId, status: 'paused' });
      }
    } catch (e) {
      if (reason) this.noteGoal(threadId, { status: was });
      throw e;
    }
    this.noteGoal(threadId, r?.goal ?? { status: 'paused' });
    return r;
  }

  /**
   * What Sage knows of a thread's goal; the store keeps the active ones (and the ones quitting paused).
   * @this {CodexAdapter}
   */
  noteGoal(threadId, goal, /** @type {string | null} */ reason = null) {
    if (!threadId) return;
    const status = goal?.status ?? null;
    // null: the goal was cleared, which the gates read rather than a window's older report of it (#2759)
    this.goals.set(threadId, status);
    if (!this.goalStore) return;
    const all = { ...(this.goalStore.read() || {}) };
    const had = all[threadId];
    let next;
    if (status === 'active') next = { status, objective: goal.objective ?? had?.objective ?? null };
    else if (status === 'paused' && (reason || had?.reason))
      next = {
        status,
        objective: goal.objective ?? had?.objective ?? null,
        reason: reason ?? had.reason,
        at: reason ? this.now() : had.at,
      };
    else next = undefined;
    if (JSON.stringify(had) === JSON.stringify(next)) return;
    if (next) all[threadId] = next;
    else delete all[threadId];
    try {
      this.goalStore.write(all);
    } catch (error) {
      // the in-memory goal state stays correct; only crash recovery loses this entry
      noteIgnored('record a Codex goal for crash recovery', error);
    }
  }

  /**
   * For the exit gate: set every active Codex goal paused and stop its turn, so nothing carries on
   * while MoPilot is gone; each is recorded as paused at quit. Resolves the chats it paused, at
   * the latest after `timeoutMs`.
   * @this {CodexAdapter}
   */
  async pauseAllActiveGoals({ timeoutMs = 3_000 } = {}) {
    const ids = [...this.goals].filter(([, st]) => st === 'active').map(([id]) => id);
    if (!ids.length || this.down || !this.server.proc) return [];
    const done = [];
    const one = async (threadId) => {
      await this.pauseFirst(threadId, 'quit');
      done.push(this.chatOf(threadId));
      const turnId = this.turnOf.get(threadId);
      if (turnId)
        // the turn may have ended already
        await this.request('turn/interrupt', { threadId, turnId }).catch((error) => noteIgnored("stop a Codex goal's turn at quit", error));
    };
    let timer;
    await Promise.race([Promise.allSettled(ids.map(one)), new Promise((res) => (timer = clock.setTimeout(res, timeoutMs)))]);
    clock.clearTimeout(timer);
    return done;
  }
  /** @this {CodexAdapter} */
  hasActiveGoals() {
    return [...this.goals.values()].includes('active');
  }

  /**
   * At the first start of a run: goals the store still lists as active (the last run crashed) are paused.
   * @this {CodexAdapter}
   */
  async recoverGoals() {
    const left = Object.entries((this.goalStore && this.goalStore.read()) || {}).filter(([, e]) => e?.status === 'active');
    for (const [threadId] of left) {
      try {
        // unanswered: paused below like a goal still running
        const g = await this.request('thread/goal/get', { threadId }).catch(
          (error) => (noteIgnored('read a Codex goal left from the last run', error), null),
        );
        // gone, or no longer running: nothing to stop
        if (g && g.goal?.status !== 'active') {
          this.noteGoal(threadId, g.goal ?? null);
          continue;
        }
        await this.pauseFirst(threadId, 'quit');
      } catch {
        // a thread that's gone: forget it rather than try again every launch
        if (!this.down) this.noteGoal(threadId, null);
      }
    }
  }

  /**
   * The note a goal paused at quit carries (src/components/composer/Composer.tsx GoalBar).
   * @this {CodexAdapter}
   */
  annotateGoal(chatId, goal) {
    if (!goal || typeof goal !== 'object' || goal.status !== 'paused' || goal.claude) return goal;
    const nid = this.codexThread(chatId);
    const e = nid && this.goalStore ? (this.goalStore.read() || {})[nid] : null;
    return e?.reason === 'quit' ? { ...goal, pausedAtQuit: true } : goal;
  }
}

/** The Codex goals that are active, or that quitting paused, kept across runs in `file`. */
function codexGoalStore(file) {
  let cache = null;
  return {
    read: () => (cache ??= readStateFile(file, 'the Codex goals') || {}),
    write: (all) => {
      writeAtomic(file, JSON.stringify(all, null, 2));
      cache = all;
    },
  };
}

module.exports = { CodexGoals, codexGoalStore };
