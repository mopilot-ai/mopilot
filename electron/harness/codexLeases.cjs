// The Codex adapter's writer leases (design §07): a thread is loaded only to write, and let go once idle.
const { clock } = require('../platform/ports/clock.cjs');
const { codexUnfinished, localTurnRunning } = require('../session/contract/reconcile.cjs');
const { assertCodexRef } = require('./codexRef.cjs');
const { CodexRunPermission } = require('./codexRunPermission.cjs');
const { noteIgnored, ignoring, messageOf } = require('../ignored.cjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');

class ThreadLocked extends Error {
  constructor() {
    super('This chat is open in another Codex app.');
    this.code = 'locked';
  }
}

/** Release a held thread once it has been quiet this long. */
const RELEASE_IDLE_MS = 5_000;

/**
 * Requests that start a model run on the thread's own settings: unlike turn/start they carry no permission, and a
 * resumed thread falls back to Codex's default sandbox, so the chat's permission is applied first (applyPermission).
 * Every goal change but a pause counts: a new objective or a raised budget can let Codex carry a stopped goal on.
 */
const runsOnThreadSettings = (method, params) => method === 'review/start' || (method === 'thread/goal/set' && params?.status !== 'paused');

/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter the adapter these methods run on */

class CodexLeases extends CodexRunPermission {
  /* -- writer leases (design §07) ----------------------------------- */
  /*
   * A thread loaded in an app-server holds its writer lock, and every other client can then only
   * read it. So Sage loads a thread only to write: it resumes right before a turn (or another
   * write), and unsubscribes once the thread has been idle a few seconds.
   */
  /** @this {CodexAdapter} */
  hold(threadId, thread) {
    const had = this.leases.get(threadId);
    // loaded here, Sage is its writer: no other app is running it
    const chat = this.chatOf(threadId);
    if (!had && this.state?.has(chat)) this.state.markLocalWriter(chat);
    if (!had && this.state?.has(chat) && this.state.get(chat).runningElsewhere) this.state.patch(chat, { runningElsewhere: false });
    this.leases.set(threadId, { at: this.now(), pinned: had?.pinned ?? false });
    if (thread) this.meta.set(threadId, thread);
    // the chat it belongs to, as main knows it now (a switch claims its thread before the windows learn the segment);
    // a thread of its own carries its metadata so the windows list it
    if (!had) this.emit({ kind: 'lease', threadId, chatId: chat, held: true, thread: thread && chat === threadId ? thread : null });
  }
  /** @this {CodexAdapter} */
  drop(threadId, reason) {
    if (!this.leases.delete(threadId)) return;
    // unloaded, the thread falls back to Codex's defaults: what was applied to it is gone
    this.permissionKeys.delete(threadId);
    this.emit({ kind: 'lease', threadId, chatId: this.chatOf(threadId), held: false, reason });
  }
  /** @this {CodexAdapter} */
  touch(threadId) {
    const l = this.leases.get(threadId);
    if (l) l.at = this.now();
  }
  /** @this {CodexAdapter} */
  leaseList() {
    return [...this.leases.keys()];
  }

  /**
   * Resume a thread so Sage can write it. Throws ThreadLocked when another client holds it.
   * @this {CodexAdapter}
   */
  ensureResumed(threadId) {
    if (this.leases.has(threadId)) return Promise.resolve();
    let p = this.resuming.get(threadId);
    if (p) return p;
    // never before the last run's active goals are paused: resuming one would carry it on
    p = Promise.resolve(this.recovering).then(() => this.resume(threadId));
    this.resuming.set(threadId, p);
    // callers get `p` with its error; settled either way, it leaves the map
    const forget = () => this.resuming.get(threadId) === p && this.resuming.delete(threadId);
    p.then(forget, forget);
    return p;
  }
  /** @this {CodexAdapter} */
  resume(threadId) {
    return this.request('thread/resume', { threadId, excludeTurns: true })
      .then((r) => {
        this.hold(threadId, r?.thread ?? null);
        this.planChip(threadId, r?.collaborationMode);
      })
      .catch((e) => {
        if (/active writer/i.test(String(e?.message))) throw new ThreadLocked();
        throw e;
      });
  }

  /**
   * Keep a lease regardless of activity (a voice session).
   * @this {CodexAdapter}
   */
  pin(threadId, on) {
    const l = this.leases.get(threadId);
    if (!l) return;
    l.pinned = !!on;
    if (!on) l.at = this.now();
  }

  /**
   * Let go of held threads that have gone idle, so other Codex clients can write them.
   * @this {CodexAdapter}
   */
  releaseIdle() {
    const now = this.now();
    for (const [id, l] of this.leases) {
      const m = this.meta.get(id);
      // ephemeral threads (side chats, helpers) live only in the app-server, and so does one with no message yet
      // (codexUnrecorded.cjs): unloading would lose them
      if (!m || m.ephemeral || this.unrecorded.has(id) || l.pinned || this.releasing.has(id) || this.inUse(id)) continue;
      if (now - l.at < RELEASE_IDLE_MS) continue;
      this.releasing.add(id);
      // a release that failed keeps the lease; the next idle sweep tries again
      this.release(id)
        .catch(ignoring('release an idle Codex thread'))
        .finally(() => this.releasing.delete(id));
    }
  }
  /**
   * Whether Sage is using the thread: a hidden or regular turn runs on it, or its chat is mid-turn, waiting or has work queued.
   * @this {CodexAdapter}
   */
  inUse(id) {
    if (this.hidden.has(id) || this.running.has(id)) return true;
    const chat = this.chatOf(id);
    const s = this.state?.has(chat) ? this.state.get(chat) : null;
    return !!s && (s.turn === 'running' || s.turn === 'awaitingUser' || s.queue.length > 0 || s.approvals.length > 0);
  }
  /** @this {CodexAdapter} */
  async release(id) {
    // the plugin's cleanup runs on this connection: one still running keeps the lease until the next sweep;
    // a failed one does not, since unloading ends the thread's plugin session (a resume starts a fresh one)
    if (this.nativeLifecycle.releasing(id)) return;
    const at = this.leases.get(id)?.at;
    // Work that outlives a turn keeps the lease: background terminals, queued follow-ups, an active goal.
    const busy = await Promise.all([
      this.request('thread/backgroundTerminals/list', { threadId: id }).then(
        (r) => (r?.data ?? r?.terminals ?? []).length > 0,
        () => false,
      ),
      this.request('thread/queue/list', { threadId: id }).then(
        (r) => (r?.data ?? r?.items ?? []).length > 0,
        () => false,
      ),
      this.request('thread/goal/get', { threadId: id }).then(
        (r) => r?.goal?.status === 'active',
        () => false,
      ),
    ]);
    const l = this.leases.get(id);
    if (!l) return;
    if (busy.some(Boolean)) {
      l.at = this.now() + 25_000; // look again in half a minute
      return;
    }
    // a turn or write that started while Codex was asked touched the lease: it keeps it
    if (l.at !== at || this.inUse(id)) return;
    this.drop(id, 'released');
    // the thread may already be unloaded
    await this.request('thread/unsubscribe', { threadId: id }).catch((error) => noteIgnored('release an idle Codex thread', error));
  }

  /**
   * Whether another client is running a turn on this thread (reconcile, WP5-19): not one Sage holds
   * or runs, and its last turns on disk include one still going.
   * @this {CodexAdapter}
   */
  ownsThreadWork(threadId) {
    if (this.leases.has(threadId) || this.running.has(threadId)) return true;
    return localTurnRunning(this.state, this.chatOf(threadId));
  }

  /** @this {CodexAdapter} */
  async runningElsewhere(threadId) {
    if (this.ownsThreadWork(threadId)) return false;
    const chat = this.chatOf(threadId);
    const writer = this.state?.localWriterToken(chat);
    const r = await this.request('thread/turns/list', { threadId, limit: 3, itemsView: 'full' });
    return writer === this.state?.localWriterToken(chat) && !this.ownsThreadWork(threadId) && (r?.data ?? []).some(codexUnfinished);
  }

  /**
   * The folder a thread runs in, as the app-server last told us.
   * @this {CodexAdapter}
   */
  cwdOf(threadId) {
    return this.meta.get(threadId)?.cwd ?? null;
  }

  /**
   * The folder a thread runs in, for a chat this app-server run may not have touched (MoPilot restarted since): read
   * from the thread's saved metadata when unknown. thread/read without turns doesn't load the thread, so no writer lock
   * is taken and no lease counts. null when Codex can't say.
   * @this {CodexAdapter}
   * @returns {Promise<string | null>}
   */
  async folderOf(threadId) {
    const known = this.cwdOf(threadId);
    if (known) return known;
    try {
      const thread = (await this.threadRead(threadId))?.thread;
      // a start or resume that answered meanwhile is newer than this read
      if (thread?.cwd && !this.meta.has(threadId)) this.meta.set(threadId, thread);
      return this.cwdOf(threadId) ?? thread?.cwd ?? null;
    } catch (error) {
      noteIgnored("read a Codex chat's folder", error);
      return null;
    }
  }

  /**
   * The chat's current native thread, when it is a Codex one.
   * @this {CodexAdapter}
   */
  codexThread(chatId) {
    const ref = this.nativeOf(chatId);
    return ref && ref.kind === 'codex' ? assertCodexRef(ref).id : null;
  }

  /**
   * Run a write that needs the chat's thread loaded (goal, compact, revert, review, shell command)
   * under a lease, on nativeOf(chat). `{ locked: true }` when another client holds the thread.
   * @this {CodexAdapter}
   */
  async leased(chatId, method, params = {}) {
    const nid = this.codexThread(chatId);
    if (!nid) throw new Error("This chat isn't running on Codex");
    try {
      await this.ensureResumed(nid);
    } catch (e) {
      if (e instanceof ThreadLocked) return { locked: true };
      throw e;
    }
    this.touch(nid);
    if (runsOnThreadSettings(method, params)) await this.applyPermission(chatId, nid);
    if (method === 'thread/compact/start') this.compacting.add(nid);
    try {
      // a failed request leaves no compaction on its way
      const result = await this.request(method, { ...params, threadId: nid }).catch((e) => {
        this.compacting.delete(nid);
        throw e;
      });
      if (method === 'thread/goal/set' && result?.goal) {
        this.noteGoal(nid, result.goal);
        this.permissionCaughtUp(chatId, nid);
      }
      if (method === 'thread/goal/clear') this.noteGoal(nid, null);
      return { result };
    } finally {
      this.touch(nid);
    }
  }

  /**
   * The chat's name (or its first message) as the app-server has it, for a notification.
   * @this {CodexAdapter}
   */
  chatName(chatId) {
    const m = this.meta.get(this.codexThread(chatId));
    const t = String(m?.name || m?.preview || '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.length > 60 ? `${prefixUnits(t, 59)}…` : t || null;
  }

  /**
   * The chat's goal status as this adapter recorded it (thread/goal/set answers, goal/updated): null once it saw the goal
   * cleared, undefined without a record and for a chat on another harness (the gates ask about every chat, so this never throws).
   * @this {CodexAdapter}
   * @param {string} chatId
   */
  ownGoalStatus(chatId) {
    const ref = this.nativeOf(chatId);
    return ref?.kind === 'codex' ? this.goals.get(ref.id) : undefined;
  }

  /**
   * Whether the chat's goal is active: the adapter's own record, kept as thread/goal/set answers and goal/updated arrives;
   * a window's report of it only for a thread the adapter has no record of. The report lags (a window writes it back
   * after main's goal event) and is missing with no window open, so a stop that reads only it can leave a goal running.
   * @this {CodexAdapter}
   * @param {string} chatId @param {string} nid
   */
  goalActive(chatId, nid) {
    const own = this.goals.get(nid);
    return own !== undefined ? own === 'active' : this.state?.get(chatId)?.goal?.status === 'active';
  }

  /**
   * Stop the chat's turn for the user, as the Stop button does: an active goal is set to paused first
   * (it would carry on in this turn and the next), then the running turn is interrupted.
   * @this {CodexAdapter}
   */
  async stopTurn(chatId) {
    const nid = this.codexThread(chatId);
    if (!nid) return this.stopLog(`[codex-stop] chat=${chatId} no Codex thread is known for it: nothing to interrupt`), false;
    const s = this.state?.get(chatId);
    if (this.goalActive(chatId, nid)) {
      // a hung call must not hold up the interrupt
      // A goal left active starts the next turn after the interrupt below, so the user is told when it stays on.
      const paused = this.leased(chatId, 'thread/goal/set', { status: 'paused' }).catch((e) => {
        // a goal that ended meanwhile needed no pause
        if (this.goalActive(chatId, nid))
          this.emit({ kind: 'toast', level: 'error', text: `Couldn't pause the goal, so it may go on: ${messageOf(e)}` }, 'any');
        else noteIgnored('pause a Codex goal that already ended', e);
      });
      await Promise.race([paused, new Promise((r) => clock.setTimeout(r, 500))]);
    }
    const turnId = s?.activeTurn?.id;
    this.stopLog(
      `[codex-stop] chat=${chatId} thread=${nid} turn=${turnId ?? 'none'}${String(turnId).startsWith('pending-') ? ' (a token: no interrupt can be sent yet)' : ''}`,
    );
    // on a native thread the plugin's release runs on in the background (the strip shows it)
    let pending = false;
    if (turnId && !String(turnId).startsWith('pending-'))
      await this.request('turn/interrupt', { threadId: nid, turnId }).catch((e) => {
        // a turn that ended meanwhile needed no stop; one still running is what the user asked to end
        if (this.state?.get(chatId)?.activeTurn?.id !== turnId) return noteIgnored('stop a Codex turn that already ended', e);
        // a thread the plugin holds says so at once; any other keeps being interrupted (the turn may not have begun: codexInterruptRepeat.cjs), and says when it gives up
        if (this.isNative(nid)) this.emit({ kind: 'toast', level: 'error', text: `Couldn't stop: ${messageOf(e)}` }, 'any');
        else pending = true;
      });
    return pending ? 'pending' : true;
  }
}

module.exports = { CodexLeases, ThreadLocked, RELEASE_IDLE_MS, runsOnThreadSettings };
