// Client lifecycle forwarding for the original plugin. Some app-server builds discover its tools
// but omit the bundled hooks. Use the public tool-call API on the SAME connection, never a second
// executor or made-up turn metadata. The cleanup contract matches the original plugin's hooks
// (Stop, Interrupt and SubagentStop all call cua_repl's turn_ended).
//
// Stop is fast: the Interrupt hook (and a JS reset when a js call is in flight) goes out together
// with turn/interrupt instead of after turn/completed, and the release runs in the background. The
// next turn waits only until the stopped turn has ended; what waits for the release is the next
// native operation (a cua_repl approval is held, and native work started on a failed release stops
// the turn), never the whole next turn.

const { identityKey } = require('../../../shared/identityKey.mjs');
const { isCodexChildThreadId } = require('../../../shared/codexAgentRelations.mjs');
const { skyProblemOfItem, skyStepWorked } = require('../../../shared/skyComputerUse.mjs');
const { CuaKernels } = require('../../../shared/cuaProgram.mjs');
const { CodexThreadParents } = require('./codexParents.cjs');

/** cua_repl calls that end a turn's control, and the plugin's JS kernel reset. */
const SERVER = 'cua_repl';
/** Collab agent states after which a subagent's turn is over. */
const SUBAGENT_ENDED = new Set(['interrupted', 'completed', 'errored', 'shutdown', 'notFound']);
const RESET_CONTEXT =
  'The host stopped the previous native operation and reset the original cua_repl JS kernel. Its previous in-memory bindings no longer exist. Reinitialize using the original runtime instructions and re-observe the authorized target before continuing native operations. The next operation is a new turn, not resumption of paused JavaScript.';

class NativeCodexLifecycle {
  /**
   * @param {object} o
   * @param o.call (method, params, timeoutMs) => Promise: a request on the connection the thread runs on
   * @param o.isNativeThread (threadId) => boolean: the thread runs the vendor plugin
   * @param [o.isLoadedThread] (threadId) => boolean: an explicitly configured root (legacy callers report roots through isNativeThread)
   * @param [o.onError] (threadId, error) => void: a release failed
   * @param [o.onState] (threadId, {phase, turnId, error} | null) => void: the chat's release status
   * @param [o.onBlocked] (threadId, turnId, message) => void: native work started while the last release failed
   * @param [o.onTiming] ({threadId, turnId, event: 'idle' | 'released', ms, ok}) => void: stop latency
   * @param [o.onSkyProblem] (threadId, problem, turnId) => void: a finished cua_repl call reported a Codex Computer Use
   *   (Sky) problem (shared/skyComputerUse.mjs), e.g. a version the plugin doesn't support, or a program that
   *   acted on the desktop finished without one (`{ kind: 'worked' }`: Sky had what it needs)
   * @param [o.now] () => ms
   * @param [o.timeoutMs] release timeout
   * @param [o.endTimeoutMs] turn end timeout
   * @param [o.onReset] (threadId) => void: MoPilot is resetting the thread's plugin JS kernel (its bindings are gone)
   * @param [o.parents] the sub-agent map main shares with the tool injection and the controller (codexParents.cjs)
   * @param [o.turnRunning] (threadId, turnId) => Promise<boolean>: whether the app-server still runs the turn, asked
   *   when a stopped turn's end was not confirmed in time and the next turn is about to start
   * @param [o.onStopUnconfirmed] (threadId, turnId) => void: Codex never confirmed a stopped turn ended, and the
   *   next turn goes ahead anyway (after maxEndChecks tries): say so
   * @param [o.maxEndChecks] how many tries of a next turn wait for an unconfirmed stopped turn
   */
  constructor({
    call,
    isNativeThread,
    isLoadedThread = isNativeThread,
    onError = () => {
      /* no error listener */
    },
    onState = () => {
      /* no state listener */
    },
    onBlocked = () => {
      /* no blocked listener */
    },
    onTiming = () => {
      /* no timing listener */
    },
    onSkyProblem = () => {
      /* optional cleanup; the primary operation reports its result */
    },
    now = () => Date.now(),
    timeoutMs = 60_000,
    endTimeoutMs = 15_000,
    parents = new CodexThreadParents(),
    turnRunning = null,
    onReset = () => {
      /* no reset listener */
    },
    onStopUnconfirmed = () => {
      /* no listener */
    },
    maxEndChecks = 3,
  }) {
    this.call = call;
    this.isNativeThread = isNativeThread;
    this.isLoadedThread = isLoadedThread;
    this.onError = onError;
    this.onState = onState;
    this.onBlocked = onBlocked;
    this.onTiming = onTiming;
    this.onSkyProblem = onSkyProblem;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.endTimeoutMs = endTimeoutMs;
    this.parents = parents;
    this.turnRunning = turnRunning;
    this.onReset = onReset;
    this.onStopUnconfirmed = onStopUnconfirmed;
    this.maxEndChecks = maxEndChecks;
    /** threadId -> Map(key -> release entry); the key is a tagged turn, turn-end or subagent identity tuple */
    this.threads = new Map();
    this.controlTurns = new Map();
    this.inflightJs = new Map();
    this.resetTurns = new Map();
    /** threadId -> {turnId, at, expired}: a stop the host sent whose turn/completed has not arrived yet */
    this.stops = new Map();
    /** turn/start calls waiting for a stopped turn to end */
    this.waiters = new Set();
    /** subagent thread -> {parent (the native root), turnId, stopped, native} (BU-06) */
    this.subagents = new Map();
    /** each native thread's plugin kernel bindings, to tell a program that acts on the desktop (shared/cuaProgram.mjs) */
    this.kernels = new CuaKernels();
    /** native roots whose plugin runtime has run (a cua_repl item was seen on them or their subagents) */
    this.runtimes = new Set();
    /** native root -> identity tuple -> the root/subagent turn that started native work while a release was pending */
    this.racing = new Map();
    /** reported identity tuple -> its native root and exact thread owner */
    this.blocked = new Map();
    this.epoch = 0;
  }

  observe(msg) {
    const p = msg?.params;
    if (!p) return;
    this.trackSubagents(msg, p);
    // a subagent's turn ends with SubagentStop on its root only (trackSubagents), as the plugin's own hooks do
    if (!p.threadId || this.subagents.has(p.threadId) || !this.isNativeThread(p.threadId)) return;
    // Configuration alone does not prove the runtime exists. A coding-only turn must keep
    // working when the vendor app/plugin is absent. Failed/in-flight native calls still require
    // cleanup because they may already have acquired control before reporting an error.
    if (['item/started', 'item/completed'].includes(msg.method) && p.turnId && p.item?.type === 'mcpToolCall' && p.item.server === SERVER) {
      this.runtimes.add(p.threadId);
      this.skyOutcome(msg.method, p.threadId, p.threadId, p.item, p.turnId);
      // Track actual item IDs: an interrupted turn may end while its original JS kernel keeps
      // running. A completed call, including a late completion, must never trigger a reset.
      const entry = this.threads.get(p.threadId)?.get(identityKey('turn', p.turnId));
      if (p.item.tool === 'js' && p.item.id) {
        let active = this.inflightJs.get(p.threadId);
        if (msg.method === 'item/started' && !entry?.ended) {
          if (!active) this.inflightJs.set(p.threadId, (active = new Map()));
          let ids = active.get(p.turnId);
          if (!ids) active.set(p.turnId, (ids = new Set()));
          ids.add(p.item.id);
        } else if (msg.method === 'item/completed') {
          active?.get(p.turnId)?.delete(p.item.id);
          if (!active?.get(p.turnId)?.size) active?.delete(p.turnId);
          if (!active?.size) this.inflightJs.delete(p.threadId);
        }
      }
      if (entry?.ended) return;
      // Native work after the early Interrupt hook (the turn had not stopped yet): release again at its end.
      if (msg.method === 'item/started') {
        if (entry) entry.dirty = true;
        else this.guard(p.threadId, p.turnId);
      }
      let used = this.controlTurns.get(p.threadId);
      if (!used) this.controlTurns.set(p.threadId, (used = new Set()));
      used.add(p.turnId);
      return;
    }
    if (msg?.method !== 'turn/completed' || !p.turn?.id) return;
    const { threadId } = p;
    const turnId = p.turn.id;
    this.turnEndedFor(threadId, turnId);
    // a turn that raced a release has ended: its own release covers its work from here
    this.raced(threadId, threadId, turnId);
    const hook = p.turn.status === 'interrupted' ? 'Interrupt' : 'Stop';
    const turns = this.threads.get(threadId);
    const early = turns?.get(identityKey('turn', turnId));
    if (early) {
      // Duplicate notifications, and a turn whose stop already sent the hook, do not repeat cleanup.
      if (early.ended) return;
      early.ended = true;
      this.dropTurn(threadId, turnId);
      if (early.dirty)
        this.release(threadId, ['turn-end', turnId], {
          hook,
          sessionId: threadId,
          turnId,
          stopAt: early.stopAt,
          reset: this.inflight(threadId, turnId),
        });
      return;
    }
    const usedControl = this.dropTurn(threadId, turnId);
    this.release(
      threadId,
      ['turn', turnId],
      usedControl ? { hook, sessionId: threadId, turnId, reset: hook === 'Interrupt' && this.inflight(threadId, turnId) } : null,
      true,
    );
  }

  /** A turn's use of native control is over: forget it, and say whether it used any. */
  dropTurn(threadId, turnId) {
    const used = this.controlTurns.get(threadId)?.delete(turnId) === true;
    if (!this.controlTurns.get(threadId)?.size) this.controlTurns.delete(threadId);
    return used;
  }

  inflight(threadId, turnId) {
    return !!this.inflightJs.get(threadId)?.get(turnId)?.size;
  }

  /**
   * Starts one release: turn_ended for `hook`, with js_reset sent concurrently right after it when a
   * js call is still running (the reset frees the plugin's queue the hook would otherwise wait in).
   * Both are dispatched synchronously, so they precede anything the next turn sends on the connection.
   * Keys are tagged identity tuples; `job` null records a turn that needed no release.
   */
  release(threadId, key, job, ended = false) {
    let turns = this.threads.get(threadId);
    if (!turns) this.threads.set(threadId, (turns = new Map()));
    const entry = {
      error: /** @type {Error | null} */ (null),
      done: !job,
      work: Promise.resolve(),
      ended,
      dirty: false,
      stopAt: job?.stopAt ?? null,
      turnId: job?.turnId ?? key[key.length - 1],
    };
    turns.set(identityKey(...key), entry);
    this.publish(threadId);
    // Keep a short deduplication window; failed/pending cleanup is never discarded.
    for (const [id, old] of turns) if (turns.size > 32 && old.done && !old.error) turns.delete(id);
    if (!job) return entry;
    const epoch = this.epoch;
    const live = () => epoch === this.epoch && this.threads.get(threadId) === turns && this.isNativeThread(threadId);
    const closed = () => new Error('The original native connection closed before cleanup');
    const { hook, sessionId, turnId, reset } = job;
    // The original worker owns the Browser/Sky cleanup handlers: the hook is always sent first.
    const hookCall = live()
      ? this.call(
          'mcpServer/tool/call',
          {
            threadId,
            server: SERVER,
            tool: 'turn_ended',
            arguments: { hook_event_name: hook, session_id: sessionId, turn_id: turnId },
          },
          this.timeoutMs,
        )
      : Promise.reject(closed());
    // The js calls running now; one started after this release is the next release's.
    const running = [...(this.inflightJs.get(threadId)?.get(turnId) ?? [])];
    let resetCall;
    let resetAcked = false;
    if (reset && live()) {
      // Drop the old kernel so the next turn reinitializes rather than continuing a paused JS action.
      this.resetTurns.set(threadId, turnId);
      this.kernels.reset(threadId);
      this.onReset(threadId);
      resetCall = this.call(
        'mcpServer/tool/call',
        { threadId, server: SERVER, tool: 'js_reset', arguments: {} },
        Math.min(this.timeoutMs, 15_000),
      ).then((r) => ((resetAcked = !r?.isError && Array.isArray(r?.content)), r));
    }
    entry.work = Promise.all([hookCall, resetCall])
      .then(([result]) => {
        if (!live()) throw closed();
        if (result?.isError) throw new Error('The original runtime rejected turn cleanup');
        if (!result || !Array.isArray(result.content)) throw new Error('The original runtime did not acknowledge turn cleanup');
        if (resetCall && !resetAcked) throw new Error('The original runtime did not acknowledge JS reset');
        const ids = this.inflightJs.get(threadId)?.get(turnId);
        for (const id of running) ids?.delete(id);
        if (!ids?.size) this.inflightJs.get(threadId)?.delete(turnId);
        if (!this.inflightJs.get(threadId)?.size) this.inflightJs.delete(threadId);
        return result;
      })
      .catch((error) => {
        entry.error = error instanceof Error ? error : new Error(String(error));
        if (resetCall && !resetAcked && this.resetTurns.get(threadId) === turnId) this.resetTurns.delete(threadId);
        if (epoch === this.epoch && this.threads.get(threadId) === turns) this.onError(threadId, entry.error);
      })
      .finally(() => {
        entry.done = true;
        if (epoch !== this.epoch || this.threads.get(threadId) !== turns) return;
        if (entry.stopAt != null) this.onTiming({ threadId, turnId, event: 'released', ms: this.now() - entry.stopAt, ok: !entry.error });
        this.settle(threadId);
        this.publish(threadId);
      });
    return entry;
  }

  /**
   * Native work that started while the previous release of `root` (the thread itself, or a subagent's
   * native root) had not confirmed. `thread` runs the turn: a failed release stops that turn.
   */
  guard(root, turnId, thread = root) {
    const turns = [...(this.threads.get(root)?.values() ?? [])];
    const failed = turns.find((entry) => entry.error);
    const key = identityKey(thread, turnId);
    if (failed) {
      if (this.blocked.has(key)) return;
      this.blocked.set(key, { root, thread });
      return void this.onBlocked(
        thread,
        turnId,
        `Native browser and computer control is blocked: Codex did not confirm it released them after an earlier turn (${failed.error.message}). Restart Codex before using them again.`,
      );
    }
    if (!turns.some((entry) => !entry.done)) return;
    let set = this.racing.get(root);
    if (!set) this.racing.set(root, (set = new Map()));
    set.set(key, { thread, turnId });
  }

  /** A turn that raced a release of `root` has ended. */
  raced(root, thread, turnId) {
    this.racing.get(root)?.delete(identityKey(thread, turnId));
  }

  /** A release finished: a turn that raced it is stopped if it failed. */
  settle(threadId) {
    const turns = [...this.threads.get(threadId).values()];
    if (turns.some((entry) => !entry.done)) return;
    const racing = this.racing.get(threadId);
    this.racing.delete(threadId);
    if (!racing || !turns.some((entry) => entry.error)) return;
    for (const { thread, turnId } of racing.values()) this.guard(threadId, turnId, thread);
  }

  publish(threadId) {
    const turns = [...(this.threads.get(threadId) ?? [])];
    const failed = turns.find(([, entry]) => entry.error);
    const pending = turns.findLast(([, entry]) => !entry.done);
    this.onState(
      threadId,
      failed
        ? { phase: 'failed', turnId: failed[1].turnId, error: failed[1].error.message }
        : pending
          ? { phase: 'releasing', turnId: pending[1].turnId, error: null }
          : null,
    );
  }

  /* -- stop ----------------------------------------------------------- */

  /**
   * The host is sending turn/interrupt for this native turn: the plugin's Interrupt hook (and a JS
   * reset for a running js call) go out right now, not after turn/completed. A later Stop/Interrupt
   * for the same turn is deduplicated; native work the turn still starts is released again at its end.
   */
  interrupt(threadId, turnId) {
    if (!threadId || !turnId || !this.isNativeThread(threadId) || this.stops.get(threadId)?.turnId === turnId) return;
    if (this.threads.get(threadId)?.has(identityKey('turn', turnId))) return; // already ended, or already stopping
    const stopAt = this.now();
    this.stops.set(threadId, { turnId, at: stopAt });
    if (!this.controlTurns.get(threadId)?.has(turnId)) return;
    this.release(threadId, ['turn', turnId], {
      hook: 'Interrupt',
      sessionId: threadId,
      turnId,
      stopAt,
      reset: this.inflight(threadId, turnId),
    });
  }

  /** The app-server accepted the interrupt: the chat is idle from here (stop → idle). */
  acknowledged(threadId, turnId) {
    const stop = this.stops.get(threadId);
    if (!stop || stop.turnId !== turnId) return;
    this.onTiming({ threadId, turnId, event: 'idle', ms: this.now() - stop.at, ok: true });
  }

  /** The interrupt was refused: the turn did not stop, so nothing waits for it to end. */
  interruptFailed(threadId, turnId) {
    if (this.stops.get(threadId)?.turnId === turnId) this.stops.delete(threadId);
  }

  turnEndedFor(threadId, turnId) {
    if (this.stops.get(threadId)?.turnId === turnId) this.stops.delete(threadId);
    for (const waiter of this.waiters) if (waiter.threadId === threadId && !this.stops.has(threadId)) waiter.finish();
  }

  /**
   * The next turn on a stopped thread waits only until the stopped turn has ended (a turn/start
   * while it still runs would be steered into it), not for the plugin's release. When its end was not
   * confirmed in time the stop is kept: the next try asks the app-server whether the turn still runs and
   * goes ahead once it doesn't (or it can't say), never into a turn it reports running.
   * @returns {Promise<void>}
   */
  async turnEnded(threadId) {
    const stop = this.stops.get(threadId);
    if (!stop) return;
    if (stop.expired) {
      // bounded: after maxEndChecks tries the next turn goes ahead, with a warning, rather than wait until Codex restarts
      stop.checks = (stop.checks ?? 0) + 1;
      if (stop.checks >= this.maxEndChecks) {
        this.stops.delete(threadId);
        return void this.onStopUnconfirmed(threadId, stop.turnId);
      }
      let running = false;
      try {
        running = this.turnRunning ? (await this.turnRunning(threadId, stop.turnId)) === true : false;
      } catch {
        // the app-server can't say: go ahead, as an unconfirmed end always did
        running = false;
      }
      // the turn ended (or another stop replaced it) while the app-server was asked
      if (this.stops.get(threadId) !== stop) return this.turnEnded(threadId);
      if (!running) return void this.stops.delete(threadId);
      stop.expired = false;
    }
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = {
        threadId,
        finish: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve();
        },
        fail: (error) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          reject(error);
        },
      };
      this.waiters.add(waiter);
      timer = setTimeout(() => {
        // Do not hold this turn behind a turn/completed that never came; the next try checks the turn first.
        if (this.stops.get(threadId) === stop) stop.expired = true;
        waiter.fail(new Error('Codex has not confirmed that the stopped turn ended. Try again.'));
      }, this.endTimeoutMs);
    });
  }

  /** The thread (or a subagent's native root) still has a release that has not confirmed. */
  pending(threadId) {
    const root = this.subagents.get(threadId)?.parent ?? threadId;
    return [...(this.threads.get(root)?.values() ?? [])].some((entry) => !entry.done || entry.error) ? root : null;
  }

  /* -- subagents (BU-06) ---------------------------------------------- */

  /** Subagents a native thread spawned: their turns end with the plugin's SubagentStop hook. */
  trackSubagents(msg, p) {
    const item = p.item;
    // thread/started naming its parent, a spawn call naming its children, a sub-agent's activity item
    for (const [child, parent] of this.parents.observe(msg)) this.adopt(child, parent);
    switch (msg.method) {
      case 'item/started':
      case 'item/completed':
        if (!p.threadId) return;
        if (item?.type === 'collabAgentToolCall') {
          for (const [id, state] of Object.entries(item.agentsStates ?? {})) {
            if (SUBAGENT_ENDED.has(state?.status)) this.subagentEnded(id, p.turnId);
            else this.subagentActive(id);
          }
        } else if (item?.type === 'subAgentActivity' && item.agentThreadId) {
          if (item.kind === 'completed' || item.kind === 'interrupted') this.subagentEnded(item.agentThreadId, p.turnId);
          else this.subagentActive(item.agentThreadId);
        } else if (item?.type === 'mcpToolCall' && item.server === SERVER && this.subagents.has(p.threadId)) {
          const sub = this.subagents.get(p.threadId);
          sub.native = true;
          this.runtimes.add(sub.parent);
          this.skyOutcome(msg.method, p.threadId, sub.parent, item);
          // native work while the root's last release is unconfirmed: it races it, or stops if it failed
          if (msg.method === 'item/started' && p.turnId) this.guard(sub.parent, p.turnId, p.threadId);
        }
        return;
      case 'turn/started':
        if (p.turn?.id && this.subagents.has(p.threadId))
          Object.assign(this.subagents.get(p.threadId), { turnId: p.turn.id, stopped: false });
        return;
      case 'turn/completed':
        if (p.turn?.id && this.subagents.has(p.threadId)) {
          const sub = this.subagents.get(p.threadId);
          sub.turnId = p.turn.id;
          this.raced(sub.parent, p.threadId, p.turn.id);
          this.subagentEnded(p.threadId, p.turn.id);
        }
        return;
      case 'thread/closed':
        this.kernels.reset(p.threadId);
        if (this.subagents.has(p.threadId)) {
          this.subagentEnded(p.threadId, null);
          this.subagents.delete(p.threadId);
        }
    }
  }

  /**
   * What a cua_repl call on `threadId`'s kernel says about Codex Computer Use, reported for its native `root`:
   * a problem it reported, or `{ kind: 'worked' }` for a program that called a bound app or Sky (not only found
   * one) and finished without a sign of a stop. Each finished program's assignments are kept in order, so one
   * acting on an app bound earlier counts.
   */
  skyOutcome(method, threadId, root, item, turnId = null) {
    if (item.tool === 'js_reset') return void this.kernels.reset(threadId);
    if (method !== 'item/completed') return;
    const acts = item.tool === 'js' && this.kernels.use(threadId, item.arguments?.code).acts;
    const problem = skyProblemOfItem(item);
    if (problem) this.onSkyProblem(root, problem, turnId);
    else if (acts && skyStepWorked(item)) this.onSkyProblem(root, { kind: 'worked' });
  }

  adopt(id, parent) {
    const root = this.subagents.get(parent)?.parent ?? parent;
    if (!isCodexChildThreadId(id, root) || this.subagents.has(id) || this.isLoadedThread(id) || !this.isNativeThread(root)) return;
    this.subagents.set(id, { parent: root, turnId: null, stopped: false, native: false });
  }

  subagentActive(id) {
    const sub = this.subagents.get(id);
    if (sub) sub.stopped = false;
  }

  /**
   * A subagent's turn ended: SubagentStop on its native root, as the original hook does
   * (session_id is the agent, turn_id its turn). Sent only once the plugin runtime has run, so a
   * coding-only session never depends on the plugin being present.
   */
  subagentEnded(id, fallbackTurnId) {
    const sub = this.subagents.get(id);
    if (!sub || sub.stopped) return;
    const turnId = sub.turnId ?? fallbackTurnId;
    if (!turnId || !(sub.native || this.runtimes.has(sub.parent))) return;
    sub.stopped = true;
    sub.turnId = null;
    const key = ['subagent', id, turnId];
    if (this.threads.get(sub.parent)?.has(identityKey(...key))) return;
    this.release(sub.parent, key, { hook: 'SubagentStop', sessionId: id, turnId });
  }

  /* -- the next turn and unloading ------------------------------------ */

  /** Thread unload and other gated requests wait for actual cleanup acknowledgement. */
  has(threadId) {
    return this.threads.has(threadId);
  }

  /** Public turn context reports a host-side reset without impersonating a human message. */
  resetContext(threadId) {
    const turnId = this.resetTurns.get(threadId);
    return turnId ? { turnId, context: { kind: 'application', value: RESET_CONTEXT } } : null;
  }

  contextForwarded(threadId, turnId) {
    if (this.resetTurns.get(threadId) === turnId) this.resetTurns.delete(threadId);
  }

  /** A release of the thread is still running. */
  releasing(threadId) {
    return [...(this.threads.get(threadId)?.values() ?? [])].some((entry) => !entry.done);
  }

  /**
   * Waits up to `maxMs` for the thread's releases still running; never throws. Unloading, archiving,
   * deleting and compacting a thread go ahead after it: a failed or slow release must not keep a thread
   * loaded or undeletable until Codex restarts (unloading ends the thread's plugin session anyway).
   * @returns {Promise<void>}
   */
  async settled(threadId, maxMs) {
    const entries = [...(this.threads.get(threadId)?.values() ?? [])];
    let timer;
    const timedOut = new Promise((resolve) => (timer = setTimeout(resolve, maxMs)));
    await Promise.race([Promise.all(entries.map((entry) => entry.work)), timedOut]);
    clearTimeout(timer);
  }

  async ready(threadId) {
    const turns = this.threads.get(threadId);
    if (!turns) return;
    const entries = [...turns.values()];
    const epoch = this.epoch;
    await Promise.all(entries.map((entry) => entry.work));
    if (epoch !== this.epoch) throw new Error('Codex disconnected before native cleanup was confirmed');
    const failed = entries.find((entry) => entry.error);
    if (failed) throw new Error(`Native control cleanup failed. Restart Codex before continuing: ${failed.error.message}`);
  }

  clear() {
    this.epoch++;
    const ids = [...this.threads.keys()];
    this.threads.clear();
    this.controlTurns.clear();
    this.inflightJs.clear();
    this.resetTurns.clear();
    this.stops.clear();
    this.subagents.clear();
    this.runtimes.clear();
    this.racing.clear();
    this.blocked.clear();
    this.kernels.clear();
    this.parents.clear();
    for (const id of ids) this.onState(id, null);
    for (const waiter of this.waiters) waiter.fail(new Error('Codex disconnected before the stopped turn ended'));
  }

  forget(threadId) {
    this.threads.delete(threadId);
    this.controlTurns.delete(threadId);
    this.inflightJs.delete(threadId);
    this.resetTurns.delete(threadId);
    this.stops.delete(threadId);
    this.runtimes.delete(threadId);
    this.racing.delete(threadId);
    this.kernels.reset(threadId);
    for (const [key, owner] of this.blocked) if (owner.thread === threadId || owner.root === threadId) this.blocked.delete(key);
    for (const [id, sub] of this.subagents) if (sub.parent === threadId) this.subagents.delete(id);
    this.onState(threadId, null);
    for (const waiter of this.waiters)
      if (waiter.threadId === threadId) waiter.fail(new Error('The native thread closed before the stopped turn ended'));
  }
}

/**
 * A chat's release status from its threads' (a chat that switched harness and back has several): a failure
 * of any of them, else a release still running, else none. `mine` picks the chat's threads.
 * @param {Map<string, { phase: string, turnId: string, error: string | null }>} states
 * @param {(threadId: string) => boolean} mine
 */
function chatCleanupState(states, mine) {
  const own = [...states].filter(([id]) => mine(id)).map(([, st]) => st);
  return own.find((st) => st.phase === 'failed') ?? own.find((st) => st.phase === 'releasing') ?? null;
}

module.exports = { NativeCodexLifecycle, RESET_CONTEXT, chatCleanupState };
