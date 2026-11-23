// The scheduler (WP7-18, A19): it runs in main, so scheduled tasks fire whether or not a window is open, and each scheduled time runs once.
// Every 30 s, when MoPilot opens and when the computer wakes, it reads the tasks (electron/platform/automationStore.cjs)
// and, for each, the latest time its rule names. A time that no one handled yet runs once:
// - another MoPilot (another build or profile) may be checking too, so a run starts only after claiming that
//   time in the run ledger (electron/platform/runLedger.cjs);
// - a native app that runs the task too (the Codex app, Claude Desktop) runs it itself while it is open; when
//   it is closed MoPilot runs it and first records the run in the app's store (electron/platform/nativeSchedulers.cjs);
// - a time missed while nothing was open is caught up once, for the latest missed time within 7 days, as Claude
//   Desktop and the Codex app do; older misses are dropped, and a run is skipped while the task's previous run
//   is still going.
// A run is the same function as "Run now" (electron/platform/automationRun.cjs). It also marks an unattended run
// whose approval nobody answered for an hour as "needs attention". A run may decline its time (MoMo's routines in
// quiet hours, say: RunSkipped); that time is recorded as skipped, like a missed one, and told to `skipped`.
const { RRule } = require('rrule');
const { withAsyncCleanup } = require('./fsutil.cjs');
const { scheduleRules, scheduleTime, ATTENTION_MS, CATCH_UP_MS } = require('../../shared/schedule.mjs');
const { runWithOf, canonicalTask } = require('../../shared/scheduleTask.mjs');

const TICK_MS = 30_000;
const rules = scheduleRules(RRule);

/** The RRULE's next occurrence after a time (the same as nextRun in src/lib/automations.ts). */
const nextRun = (rule, after) => rules.nextRun(rule, after);

/** A run later than this after its time is a catch-up, and says so. */
const LATE_MS = 2 * TICK_MS;

/** A chat whose turn is still going. */
const BUSY = new Set(['running', 'awaitingUser']);

/** A run declined its time on purpose (not a failure): recorded as skipped with `reason`, and nobody is notified. */
class RunSkipped extends Error {
  constructor(/** @type {string} */ reason) {
    super(`The run was skipped: ${reason}`);
    this.reason = reason;
  }
}

class Scheduler {
  /**
   * @param {object} o
   * @param o.enabled () => boolean: the "run schedules" setting
   * @param o.list () => Promise<task[]>: AutomationStore.list's tasks, each with its native_app
   * @param o.run (task) => Promise<string>: start the run, resolving to its chat
   * @param o.sessions SessionStore (electron/session/state.cjs)
   * @param o.ledger RunLedger
   * @param [o.natives] {Record<string, any>} the native apps by id (nativeSchedulers.cjs codexApp, claudeDesktop)
   * @param [o.before] () => Promise<void>: before each check (AutomationStore.sync)
   * @param [o.validate] (task) => Promise<task>: reread an active listed task before calculating or claiming its run
   * @param [o.notify] (chatId | null, task, {catchUp, error?}) => void: a run started, or (with error) failed to
   * @param [o.skipped] (task, due, reason) => void | Promise<void>: a time was skipped (awaited) (missed, previous-running, or the run's RunSkipped)
   * @param [o.independent] (task) => boolean: a task the "run schedules" setting doesn't gate (MoMo's routines, which
   *   have their own setting and gate, checked by their run)
   * @param [o.now] () => number
   * @param [o.tickMs] how often due tasks are checked (0: only when asked)
   * @param [o.log] (line) => void
   */
  constructor(o) {
    this.enabled = o.enabled;
    this.list = o.list;
    this.run = o.run;
    this.validate = o.validate;
    this.sessions = o.sessions;
    this.ledger = o.ledger;
    this.natives = o.natives ?? {};
    this.before =
      o.before ??
      (async () => {
        /* nothing to bring up to date */
      });
    this.notify =
      o.notify ??
      (() => {
        /* no notifier */
      });
    this.independent = o.independent ?? (() => false);
    this.hasIndependent = !!o.independent;
    this.skipped =
      o.skipped ??
      (() => {
        /* nobody keeps skipped times beside the ledger */
      });
    this.clock = o.now ?? Date.now;
    this.tickMs = o.tickMs === undefined ? TICK_MS : o.tickMs;
    this.log =
      o.log ??
      (() => {
        /* no logger */
      });
    /** moves the clock on (tests) */
    this.skew = 0;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    /** @type {Promise<unknown>} keeps ticks in order */
    this.chain = Promise.resolve();
    /** chat -> pending approval lifetime -> when this request was first seen waiting */
    this.waiting = new Map();
    /** tasks already logged as left to a native app whose store isn't recognized */
    this.deferred = new Set();
    /** bumped by settingsChanged: a check started before a change stops launching */
    this.authorization = 0;
    this.wasEnabled = this.enabled();
    /** times at or before this were while schedules were off (or just turned back on): not missed runs */
    this.resumedAt = 0;
  }

  now() {
    return this.clock() + this.skew;
  }

  /** Start checking: once now (MoPilot just opened: catch up), then on the interval. */
  start() {
    if (this.timer) return;
    const tick = () =>
      // a failed check is retried on the next interval
      this.tick().catch((e) => this.log(`scheduled tasks: a check failed: ${e?.message ?? e}`));
    if (!this.tickMs) return;
    tick();
    this.timer = setInterval(tick, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    // clearInterval ignores null
    clearInterval(/** @type {NodeJS.Timeout | undefined} */ (this.timer));
    this.timer = null;
  }

  /** Check once; ticks never overlap. Resolves when this one is done. */
  tick() {
    const next = this.chain.then(() => this.check());
    // the chain only keeps ticks in order; the caller gets the failure through `next`
    this.chain = Promise.allSettled([next]);
    return next;
  }

  /**
   * The "run schedules" setting changed (an off/on toggle between checks counts): a check under way stops
   * launching, and the time up to now is not caught up later (#574).
   */
  settingsChanged(enabled) {
    if (enabled === this.wasEnabled) return;
    this.wasEnabled = enabled;
    this.authorization++;
    this.resumedAt = this.now();
  }

  /** Whether a check started under `authorization` may still launch: the setting is on and didn't change since. */
  authorized(authorization) {
    if (authorization === this.authorization && this.enabled()) return true;
    // time spent disabled is not a time any task missed
    if (!this.enabled()) this.resumedAt = this.now();
    return false;
  }

  /** Whether `task` may still launch in a check started under `authorization`: its own gate, or the setting's. */
  authorizedFor(task, authorization) {
    return this.independent(task) || this.authorized(authorization);
  }

  async check() {
    const authorization = this.authorization;
    const now = this.now();
    this.markAttention(now);
    const on = this.authorized(authorization);
    // with schedules off only the tasks the setting doesn't gate are looked at
    if (!on && !this.hasIndependent) return;
    if (on) await this.before();
    const list = await this.list();
    // tasks that predate the ledger don't catch up what an older MoPilot may already have run
    const baseline = await this.ledger.baseline(now);
    /** native app -> {running, read}, read once per check and only when a task needs it */
    const natives = new Map();
    for (const a of list) {
      // discovery and the previous launch may have waited while the user turned schedules off
      if (!this.authorizedFor(a, authorization)) continue;
      if (a.transfer_from || a.status !== 'ACTIVE' || typeof a.rrule !== 'string') continue;
      try {
        // The ledger and native schedule APIs address an ID, not one of several unrelated owners.
        canonicalTask(list, a.id);
        const current = this.validate ? await this.validate(a) : a;
        if (!this.authorizedFor(current, authorization)) continue;
        // A pause, transfer or reschedule accepted during discovery owns this run decision.
        if (current.transfer_from || current.status !== 'ACTIVE' || typeof current.rrule !== 'string') continue;
        await this.consider(current, now, baseline, natives, authorization);
      } catch (e) {
        this.log(`scheduled task ${a.id} did not start: ${e?.message ?? e}`);
      }
    }
    // a launch that ended with schedules off: the time since doesn't replay
    if (!this.enabled()) this.resumedAt = this.now();
  }

  /** What a native app says now: whether it is open, and what it ran. */
  async nativeState(id, cache) {
    if (!cache.has(id)) {
      const app = this.natives[id];
      cache.set(id, app ? { app, installed: app.installed(), running: await app.running(), read: app.read() } : null);
    }
    return cache.get(id);
  }

  /** One task at one check: run its latest time when no one has handled it. */
  async consider(a, now, baseline, cache, authorization) {
    const id = String(a.id);
    const due = rules.lastRun(a.rrule, now);
    if (due === null) return;
    // a time before the task was made, resumed or rescheduled is not a run it missed
    // (time with schedules off is a gap only for the tasks the setting gates)
    const floor = Math.max(scheduleTime(a.created_at), scheduleTime(a.schedule_from), baseline, this.independent(a) ? 0 : this.resumedAt);
    if (due <= floor) return;
    const native = a.native_app ? await this.nativeState(a.native_app, cache) : null;
    const entry = native?.read.ok ? native.read.tasks.get(id) : undefined;
    const latest = await this.ledger.latest(id);
    if (!this.authorizedFor(a, authorization)) return;
    if (due <= Math.max(latest, entry?.through ?? 0)) return;
    if (native?.installed && !native.read.ok) {
      // MoPilot can't tell what the app ran, nor tell it what MoPilot ran: the app runs it
      if (!this.deferred.has(id)) this.log(`scheduled task ${id} is left to ${native.app.label}: its schedule store isn't recognized`);
      this.deferred.add(id);
      return;
    }
    // the app is open and has the task: it runs it
    if (native?.running && entry) return;
    const harness = runWithOf(a);
    const missed = due < now - CATCH_UP_MS;
    const previousRunning = missed ? false : await this.previousRunning(id);
    // Native and ledger reads may have waited across an edit. Defer a changed snapshot to the next tick,
    // before even a skipped occurrence is claimed. A claim admits this snapshot; it is not a cross-process lock.
    if (this.validate && JSON.stringify(await this.validate(a)) !== JSON.stringify(a)) return;
    if (!this.authorizedFor(a, authorization)) return;
    if (missed) {
      if (await this.ledger.claim(id, due, { status: 'skipped', reason: 'missed', harness })) await this.skipped(a, due, 'missed');
      return;
    }
    if (previousRunning) {
      if (await this.ledger.claim(id, due, { status: 'skipped', reason: 'previous-running', harness }))
        await this.skipped(a, due, 'previous-running');
      return;
    }
    const catchUp = now - due > LATE_MS;
    if (!(await this.ledger.claim(id, due, { status: 'starting', harness, catchUp }))) return;
    if (!this.authorizedFor(a, authorization)) {
      await this.ledger.release(id, due);
      return;
    }
    let nativeOpen = false;
    try {
      nativeOpen = native && entry ? await native.app.running() : false;
    } catch (error) {
      return this.releaseFailedClaim(id, due, error);
    }
    // The claim and native-app confirmation may both have waited across an off/on transition.
    if (!this.authorizedFor(a, authorization)) {
      await this.ledger.release(id, due);
      return;
    }
    if (native && entry) {
      // it may have opened since: then it runs this time itself
      let ok;
      try {
        ok = !nativeOpen && native.app.markHandled(id, due, rules.nextRun(a.rrule, new Date(now))?.getTime() ?? null, now);
      } catch (error) {
        return this.releaseFailedClaim(id, due, error);
      }
      if (!ok) {
        await this.ledger.release(id, due);
        this.log(`scheduled task ${id} waits: ${native.app.label} opened or its store is busy`);
        return;
      }
    }
    let chatId;
    try {
      chatId = await this.run(a);
    } catch (e) {
      if (e instanceof RunSkipped) {
        await this.ledger.update(id, due, { status: 'skipped', reason: e.reason });
        await this.skipped(a, due, e.reason);
        return;
      }
      const reason = String(e?.message ?? e);
      await this.ledger.update(id, due, { status: 'failed', reason, ...(e?.chatId ? { chatId: e.chatId } : {}) });
      // nobody is watching an unattended run: its failure is told, not left in the run log
      this.notify(e?.chatId ?? null, a, { catchUp, error: reason });
      throw e;
    }
    // the run started: a ledger write that fails after it is not the run failing
    await this.ledger.update(id, due, { status: 'started', chatId });
    this.notify(chatId, a, { catchUp });
  }

  /** A native pre-launch failure releases its owned claim without losing the original error to cleanup. */
  releaseFailedClaim(id, due, error) {
    return withAsyncCleanup(
      () => {
        throw error;
      },
      () => this.ledger.release(id, due),
    );
  }

  /** Whether the task's last run is still going in this app. */
  async previousRunning(id) {
    const last = await this.ledger.lastRun(id);
    return last?.status === 'started' && !!last.chatId && this.sessions.has(last.chatId) && BUSY.has(this.sessions.get(last.chatId).turn);
  }

  /** An unattended run still waiting for an approval an hour later gets marked; answering it clears the mark. */
  markAttention(now) {
    const live = new Set(this.sessions.all());
    for (const id of this.waiting.keys()) if (!live.has(id)) this.waiting.delete(id);
    for (const id of live) {
      const s = this.sessions.get(id);
      if (!s.scheduled?.unattended || !s.approvals.length) {
        this.waiting.delete(id);
        if (s.scheduled?.needsAttention) this.sessions.patch(id, { scheduled: { ...s.scheduled, needsAttention: false } });
        continue;
      }
      const previous = this.waiting.get(id);
      const pending = new Map();
      for (const approval of s.approvals) {
        const token = this.sessions.approvalToken?.(id, approval.id) ?? approval.id;
        pending.set(token, previous?.get(token) ?? now);
      }
      this.waiting.set(id, pending);
      const needsAttention = [...pending.values()].some((since) => now - since >= ATTENTION_MS);
      if (!!s.scheduled.needsAttention !== needsAttention) this.sessions.patch(id, { scheduled: { ...s.scheduled, needsAttention } });
    }
  }
}

module.exports = { Scheduler, RunSkipped, nextRun, rules, TICK_MS, LATE_MS };
