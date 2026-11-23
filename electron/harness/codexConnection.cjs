// The Codex adapter's connection: initialize and negotiate, requests and their answers, and restarts after a crash.
const { clock } = require('../platform/ports/clock.cjs');
const { killTree } = require('../platform/winbin.cjs');
const { providerError } = require('../identity/contract/codexProvider.cjs');
const { userTrust } = require('./codexTrust.cjs');
const { codexVersion, versionStatus } = require('./versions.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { interruptAndWatch } = require('./codexInterruptRepeat.cjs');
const { assertInputReady, assertInputCurrent, carryInputGuard, hasInputReadiness } = require('../session/contract/inputGuard.cjs');
const { outgoingRequest, THREAD_OPENS } = require('./codexOutgoing.cjs');
const { stopTurnCommands } = require('./codexTurnCommands.cjs');

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * Requests on a native thread that give the plugin's cleanup of the previous turn a moment first (unload,
 * compaction, archive, delete). They go ahead after NATIVE_CLEANUP_WAIT_MS, or once it failed: a stuck
 * release must not keep a thread loaded, undeletable or uncompactable until Codex restarts.
 */
const NATIVE_CLEANUP_GATED = new Set(['thread/compact/start', 'thread/unsubscribe', 'thread/archive', 'thread/delete']);
const NATIVE_CLEANUP_WAIT_MS = 5_000;
/** Requests that start a turn: they wait for a stopped turn to end, not for the plugin's release. */
function startsTurn(method, params) {
  return method === 'turn/start' || (method === 'thread/goal/set' && params?.status === 'active');
}

/**
 * How long a thread's start waits for the negotiation (what this Codex can do) before going ahead without it, tiered:
 * a probe that never answers must not hold a chat. A probe's own requests (helper) never wait: negotiate waits on them.
 */
const NEGOTIATE_WAIT_MS = 3_000;
/** `negotiated` once it settles, or nothing after NEGOTIATE_WAIT_MS; never rejects. */
function negotiatedWithin(/** @type {Promise<unknown> | null | undefined} */ negotiated) {
  if (!negotiated) return null;
  let timer;
  const cap = new Promise((resolve) => (timer = clock.setTimeout(resolve, NEGOTIATE_WAIT_MS)));
  // a failed negotiation leaves the thread tiered, the safe side; the failure is noted
  const settled = negotiated.catch((error) => noteIgnored('read what this Codex can do before a thread starts', error));
  return Promise.race([settled, cap]).finally(() => clock.clearTimeout(timer));
}

const CONNECT_TIMEOUT_MS = 30_000;
/** Waits before each restart of a crashed app-server; after the last, the windows show a banner. */
const BACKOFF_MS = [1_000, 4_000, 15_000];
/** An app-server up this long has recovered: its next crash starts the backoff over. */
const STABLE_MS = 60_000;
/** Starts in a row that ended before initialize answered, after which a default copy gives way to the next one installed. */
const FALLBACK_AFTER = 2;
/** A server that knows no installed copies (codexProcess.cjs `copies`): a copy is named by its path, and none is moved to. */
const NO_COPIES = {
  copyOf: (/** @type {string | null} */ bin) => ({ copy: { path: bin ?? 'codex', version: null, via: null, from: null }, pinned: false }),
  fallBack: (/** @type {string | null} */ _bin) => null,
};

/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter the adapter these methods run on */

/** Requests that load a thread or work in it (the idle recycler's activity, codexRecycle.cjs); reads such as lists do neither. */
const USES_THREAD = /^(turn\/|review\/start$|thread\/(realtime\/|(start|fork|resume|revert|shellCommand|compact\/start|queue\/start)$))/;

class CodexConnection {
  /* -- connection --------------------------------------------------- */
  /**
   * Connect (again) after the app-server failed or exited: until then requests fail at once
   * instead of starting a Codex no one asked for.
   * @this {CodexAdapter}
   */
  connect() {
    // down after an exit, and not on its way back by itself (that restart tells the windows when it is ready)
    const wasDown = this.down && this.restartTimer !== 'connecting';
    this.down = false;
    // however it comes back (a restart, the banner's Restart, a reconnect after it gave up), goals its exit paused
    // are paused in Codex before anything resumes their threads
    return this.initialize().then((r) => {
      this.pauseGoals();
      // one window (the banner's Restart) or a scheduled task brought it back: every window hears it is ready,
      // or the others keep showing it as down
      if (wasDown) this.onStatus({ kind: 'ready' });
      return r;
    });
  }

  /**
   * Start the app-server (if needed) and initialize it once; resolves the initialize result.
   * @this {CodexAdapter}
   */
  initialize() {
    if (this.init) return this.init;
    this.server.start();
    const proc = this.server.proc;
    // a start still looking up its binary: the process it spawns later is this one's too
    const pending = proc ? null : this.server.pending;
    const p = this.call(
      'initialize',
      { clientInfo: this.clientInfo, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } },
      CONNECT_TIMEOUT_MS,
    ).then((r) => {
      this.server.send({ method: 'initialized' });
      this.readyAt = this.now();
      this.failedStarts = 0;
      // what this Codex is and can do: its version, and a probe for each capability that a newer one may change
      this.negotiatedP = this.negotiate(r);
      // the first Codex of this run: goals the last run left active are paused before anything resumes them
      if (!this.recoveredOnce) {
        this.recoveredOnce = true;
        // a window that left Codex idle at launch connects now that something started it
        this.onFirstStart();
        this.recovering = this.recoverGoals().finally(() => (this.recovering = null));
      }
      return r;
    });
    this.init = p;
    p.catch(() => {
      if (this.init !== p) return;
      this.init = null;
      // one that never answered initialize (it took too long) can't be initialized again ("Already initialized"):
      // it is ended, so the next connect starts a fresh one (an automatic restart ends its own: scheduleRestart);
      // one still looking up its binary is given up on, so its initialize never reaches a process
      if (this.readyAt || this.restartTimer === 'connecting') return;
      const own = proc ?? pending?.proc;
      if (own && this.server.proc === own) killTree(own);
      else if (pending && this.server.pending === pending) this.server.abandon(pending, new Error('Codex took too long to start'));
    });
    return p;
  }

  /**
   * The versions policy (WP5-20): the CLI version from userAgent, whether it is supported, and which
   * capabilities' methods are there. Windows grey out only what failed (src/harness/codexCompat.ts).
   * @this {CodexAdapter}
   */
  async negotiate(init) {
    const cliVersion = codexVersion(init?.userAgent);
    const { probes, flags } = this.probe
      ? await this.probe((m, p) => this.request(m, p, { helper: true })).catch(() => ({ probes: {}, flags: {} }))
      : { probes: {}, flags: {} };
    const n = { cliVersion, versionStatus: versionStatus('codex', cliVersion), probes, flags };
    this.negotiated = n;
    this.emit({ kind: 'negotiated', negotiated: n });
    return n;
  }
  /**
   * The current app-server's negotiation, once it is known.
   * @this {CodexAdapter}
   */
  negotiation() {
    return this.negotiatedP ?? this.initialize().then(() => this.negotiatedP);
  }

  /** @this {CodexAdapter} */
  isNative(threadId) {
    return this.tools?.isNativeThread?.(threadId) === true;
  }

  /**
   * A request to the app-server, after initialize. `helper`: for a thread Sage runs itself, which gets no tools.
   * @this {CodexAdapter}
   * @param method the app-server method
   * @param [params] its params (none: `{}`)
   * @param {{ helper?: boolean, onAnswer?: (result: any) => void, fork?: import('./codexOutgoing.cjs').CodexForkReceipt, timeoutMs?: number, background?: boolean }} [opts] `onAnswer`: runs as the answer arrives,
   *   before any message after it is handled
   */
  async request(method, params, opts = {}) {
    const { helper = false, onAnswer, fork, timeoutMs = 0, background } = opts;
    if (this.down) throw new RpcError(-1, "Codex isn't connected");
    await this.initialize();
    // a chat kept apart from the coding side (MoMo's) runs the model only with its thread's memory off (codexIsolation.cjs)
    if (this.isolation?.applies(params)) params = carryInputGuard(params, await this.isolation.gate(method, params));
    if (method === 'turn/interrupt' && params?.threadId) return this.interruptTurn(params, { helper, onAnswer });
    // a native thread's next turn waits only for a stopped turn to end; its next native operation waits for the release
    if (params?.threadId && startsTurn(method, params)) await this.nativeLifecycle.turnEnded(params.threadId);
    // unloading, archiving, deleting or compacting gives the plugin's release of the last turn a moment, never more
    else if (params?.threadId && NATIVE_CLEANUP_GATED.has(method) && this.nativeLifecycle.releasing(params.threadId))
      await this.nativeLifecycle.settled(params.threadId, NATIVE_CLEANUP_WAIT_MS);
    // the thread's config turns off the user's own node_repl, which it can only do if they have one (X14)
    // and its folder-trust entries are read in the same go: the thread carries its own instead of the app-server writing the user's file (#1346)
    // and what this Codex can do (negotiate) is known first: a thread's tools are tiered unless it defers MCP tools itself
    if (/^thread\/(start|fork|resume)$/.test(method) && (this.tools || method === 'thread/start'))
      await Promise.all([this.userServers(), helper ? null : negotiatedWithin(this.negotiatedP)]);
    // after a stop reset the plugin's JS kernel, the next turn is told so (not as a user message)
    const reset = method === 'turn/start' && !helper ? this.nativeLifecycle.resetContext(params?.threadId) : null;
    if (reset) params = { ...params, additionalContext: { ...params.additionalContext, 'mopilot.native-runtime-state': reset.context } };
    // a native thread's model learns once which browser tools reach the in-app browser pane
    const note = method === 'turn/start' && !helper ? (this.tools?.turnContext?.(params?.threadId) ?? null) : null;
    const noteReceipt = note ? this.tools.contextReceipt?.(params.threadId) : undefined;
    if (note) params = { ...params, additionalContext: { ...params.additionalContext, [note.key]: note.context } };
    if (hasInputReadiness(params ?? {})) await assertInputReady(params);
    assertInputCurrent(params ?? {});
    const result = await this.call(method, params, timeoutMs, { helper, onAnswer, fork, background });
    if (method === 'turn/start') {
      // Codex recorded the thread's first message: it is on disk from here (codexUnrecorded.cjs)
      this.unrecorded.delete(params.threadId);
      // never throws: a first turn's memory goes off once Codex has the thread (codexIsolation.cjs)
      void this.isolation?.turnStarted(params.threadId);
    }
    // kept when turn/start fails; a newer reset that arrived meanwhile is not erased
    if (reset) this.nativeLifecycle.contextForwarded(params.threadId, reset.turnId);
    if (note) this.tools.contextForwarded?.(params.threadId, note.key, noteReceipt);
    return result;
  }

  /**
   * Stop, on every path (the composer, a stall banner, an agent's Stop, quit): the turn, then the commands it started
   * that still run, which the app-server's interrupt leaves going (#1940). They are read before the interrupt goes out,
   * since the stopped turn's turn/completed may arrive before its answer; a failed interrupt stops none of them.
   * @this {CodexAdapter}
   */
  async interruptTurn(params, opts) {
    const own = this.turnCommands.take(params.threadId, params.turnId);
    let result;
    try {
      result = this.isNative(params.threadId)
        ? await this.interruptNative(params)
        : await interruptAndWatch(this, params, () => this.call('turn/interrupt', params, 0, opts));
    } catch (e) {
      this.turnCommands.release(params.threadId, own);
      throw e;
    }
    if (own.length) {
      const toast = (text) => this.emit({ kind: 'toast', level: 'error', text }, 'any');
      // not awaited: the chat is idle at the interrupt's answer, as before
      void stopTurnCommands({ call: (m, p, ms) => this.call(m, p, ms), toast }, params.threadId, own);
    }
    return result;
  }

  /**
   * Stop on a native thread: the plugin's Interrupt hook (and a JS reset for a running js call) go out
   * right behind turn/interrupt rather than after turn/completed, and once the app-server accepts the
   * interrupt the chat is idle. The release finishes in the background (the strip shows it).
   * @this {CodexAdapter}
   */
  async interruptNative(params) {
    const { threadId, turnId } = params;
    const answer = this.call('turn/interrupt', params, 0);
    this.nativeLifecycle.interrupt(threadId, turnId);
    let result;
    try {
      result = await answer;
    } catch (e) {
      this.nativeLifecycle.interruptFailed(threadId, turnId);
      throw e;
    }
    this.nativeLifecycle.acknowledged(threadId, turnId);
    if (turnId) this.onStopped(this.chatOf(threadId), turnId);
    return result;
  }

  /**
   * The MCP servers the user's own Codex config defines, read once per process and handed to the tool channel.
   * A failed read hands over none for now and is read again at the next thread start.
   * @this {CodexAdapter}
   */
  userServers() {
    this.userServersP ??= this.call('config/read', { includeLayers: false })
      .then((c) => {
        this.userTrust = userTrust(c);
        return c?.config?.mcp_servers ?? {};
      })
      .catch(() => {
        this.userServersP = null;
        return {};
      })
      .then((servers) => this.tools?.setUserServers(servers));
    return this.userServersP;
  }

  /**
   * @this {CodexAdapter}
   * @param {{ helper?: boolean, onAnswer?: (result: any) => void, afterProvider?: boolean, background?: boolean, fork?: import('./codexOutgoing.cjs').CodexForkReceipt }} [opts]
   *   `background`: a read main makes on its own (codexBackgroundWork.cjs), whose timeout never keeps the process running
   */
  call(method, params, timeoutMs = 0, opts = {}) {
    // a thread opened while the active key is still being stored for its provider waits for it, or it would go out
    // without one: Codex refuses a resume whose provider is missing (#2201). Otherwise it is sent at once.
    const pending = THREAD_OPENS.has(method) && !opts.afterProvider ? this.providerPending() : null;
    if (pending) return pending.then(() => this.call(method, params, timeoutMs, { ...opts, afterProvider: true }));
    const { helper = false, onAnswer, fork } = opts;
    if (USES_THREAD.test(method)) this.lastActivity = this.now();
    // a voice session holds its thread until it closes, talking or not
    if (method === 'thread/realtime/start' && params?.threadId) this.realtime.add(params.threadId);
    if (method === 'thread/realtime/stop') this.realtime.delete(params?.threadId);
    const id = `cx:${++this.seq}`;
    return new Promise((resolve, reject) => {
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      if (timeoutMs) {
        timer = clock.setTimeout(
          () => (this.pending.delete(id), reject(new Error(`Codex app-server did not answer ${method}`))),
          timeoutMs,
        );
        if (opts.background) timer.unref?.();
      }
      this.pending.set(id, {
        resolve: (v) => (clock.clearTimeout(timer), resolve(v)),
        // a thread whose key was removed since is refused by Codex in its own words: say what happened (#2213)
        reject: (e) => (clock.clearTimeout(timer), reject(THREAD_OPENS.has(method) ? providerError(e) : e)),
        onAnswer,
      });
      const fail = (error) => {
        this.pending.delete(id);
        clock.clearTimeout(timer);
        reject(error);
      };
      try {
        this.server.send(outgoingRequest(this, { id, method, params: params ?? {} }, helper, fail, fork));
      } catch (e) {
        fail(e);
      }
    });
  }

  /** @this {CodexAdapter} */
  respond(id, result) {
    if (this.server.proc) this.server.send({ id, result });
  }

  /**
   * An answer's hook runs before anyone sees the answer, and before the next message (a notification about what it
   * started): the app-server runs it ahead of main's intercept chain, and onServer for a server that has none. It
   * runs once; a hook that fails never costs the answer (the request still settles and the tool channel still sees it).
   * @this {CodexAdapter}
   */
  answerHook(m) {
    if (m?.id == null || m.method || m.error) return;
    const p = this.pending.get(m.id);
    const hook = p?.onAnswer;
    if (!hook) return;
    p.onAnswer = null;
    try {
      hook(m.result);
    } catch (error) {
      noteIgnored("run a Codex answer's hook", error);
    }
  }

  /** @this {CodexAdapter} */
  onServer(evt) {
    for (const observe of this.serverObservers) observe(evt);
    if (evt.kind === 'message') {
      // a thread's own event (a turn's progress, a request it waits on) is activity; an answer is its request's
      if (evt.msg?.method && evt.msg.params?.threadId) this.lastActivity = this.now();
      if (evt.msg?.method === 'thread/realtime/closed') this.realtime.delete(evt.msg.params?.threadId);
      // a server that reads ahead of its intercept chain (codexProcess.cjs) already ran it; once only
      this.answerHook(evt.msg);
      // thread responses and thread/closed decide each thread's tool session; it never consumes one
      this.tools?.observe(evt.msg);
      return this.onMessage(evt.msg);
    }
    // the process is gone: nothing it held is held any more, its threads' sage-mcp included
    this.tools?.exited();
    // its Remote Control link went with it
    this.remoteControl.reset();
    for (const [, p] of this.pending) p.reject(new RpcError(-1, 'Codex app-server exited'));
    this.pending.clear();
    this.nativeLifecycle.clear();
    // requests of the process that exited are no one's to answer now
    this.heldRequests.clear();
    this.hostDeclined.clear();
    this.init = null;
    this.defaultsP = null;
    this.defaultsGood = null;
    this.modelListP = null;
    this.userServersP = null;
    this.negotiatedP = null;
    this.infoP = null;
    this.running.clear();
    this.realtime.clear();
    // the threads it started for composers went with it, and so did any with no message yet
    this.prewarmed.clear();
    // a thread with no message is not on disk: it is lost with the process, and the chat that holds it needs another (#5160)
    for (const id of this.unrecorded) this.lostUnrecorded.set(id, this.meta.get(id)?.cwd ?? null);
    this.unrecorded.clear();
    this.turnOf.clear();
    this.turnChanges?.clear();
    for (const id of [...this.leases.keys()]) this.drop(id, 'exit');
    for (const [, h] of this.hidden) h.done?.();
    this.hidden.clear();
    // its background commands and sub-agents ended with it (after its running turns are cleared)
    this.backgroundWork.clear();
    if (evt.kind === 'stopped') {
      // stopped on purpose (Settings → restart): whoever stopped it connects again
      // (clearTimeout ignores 'connecting' and null)
      clock.clearTimeout(/** @type {NodeJS.Timeout | undefined} */ (this.restartTimer));
      this.restartTimer = null;
      this.restarts = 0;
      this.failedStarts = 0;
      this.readyAt = 0;
      // its chats end as on any exit: turns it was running, approvals it asked (the next one numbers its requests from
      // the start again), active goals paused (and paused in Codex once it is back), the desktop lock let go
      this.pauseAfterExit(this.onExit('Codex restarted', evt));
      return;
    }
    // a process that is still there after an error exits next; it is counted (and restarted) once, then
    const ended = !(evt.kind === 'error' && this.server.proc);
    // a start of the copy in use that ended before initialize answered (it quit as it started, or could not be run)
    const startFailed = !this.readyAt && ended;
    if (startFailed) this.failedStarts++;
    // a Codex that was working, is being brought back, or ran and quit as it started: restart it, with backoff
    // (one that could not be spawned at all, the first time, is left down: Codex may not be installed)
    const crashed = !!this.readyAt || this.restartTimer === 'connecting' || (startFailed && evt.kind === 'exit');
    if (this.restartTimer === 'connecting') this.restartTimer = null;
    if (this.readyAt && this.now() - this.readyAt > STABLE_MS) this.restarts = 0;
    // one that answered and then failed is judged as such at its exit too, not as a start that failed
    if (ended) this.readyAt = 0;
    this.down = true;
    const restart = crashed && ended;
    // the windows hear it went (and whether it's coming back, and which copy ran and quit as it started; one that
    // could not be run at all is said by its error, ENOENT for one not installed), then the chats it was running crash
    const quit = startFailed && evt.kind === 'exit' ? (this.server.copies ?? NO_COPIES).copyOf(this.server.bin) : {};
    this.onStatus({ ...evt, ...quit, restarting: restart || (crashed && evt.kind === 'error') });
    this.pauseAfterExit(this.onExit(evt.kind === 'exit' ? 'Codex stopped' : 'Codex failed to start', evt));
    if (restart) this.scheduleRestart();
  }

  /**
   * The goals to pause once Codex is back (pauseGoals): the threads the chats' exit paused, and every goal this adapter
   * has active, which a window may not have reported into the chat's state yet, or no window is open to report.
   * @this {CodexAdapter}
   * @param {unknown} paused
   */
  pauseAfterExit(paused) {
    if (Array.isArray(paused)) for (const id of paused) this.pauseOnReconnect.add(id);
    for (const [id, status] of this.goals) if (status === 'active') this.pauseOnReconnect.add(id);
  }

  /**
   * Bring a crashed app-server back after BACKOFF_MS[n] (A23), at most that many times in a row;
   * then the windows show a banner naming the copy, and the user restarts it or picks another. A default copy that
   * quit FALLBACK_AFTER starts in a row before it answered first gives way to the next installed copy, which starts
   * the backoff over; the user's own pick is kept.
   * @this {CodexAdapter}
   */
  scheduleRestart() {
    if (this.restartTimer) return;
    const bin = this.server.bin;
    const copies = this.server.copies ?? NO_COPIES;
    const to = this.failedStarts >= FALLBACK_AFTER ? copies.fallBack(bin) : null;
    if (to) {
      this.failedStarts = 0;
      this.restarts = 0;
      // every window hears which copy runs now, before it is started
      this.onStatus({ kind: 'switched', from: copies.copyOf(bin).copy, to });
    } else if (this.restarts >= this.backoff.length) {
      this.restarts = 0;
      this.onStatus({ kind: 'gaveUp', ...copies.copyOf(bin) });
      return;
    }
    const inMs = this.backoff[this.restarts++];
    this.onStatus({ kind: 'restarting', attempt: this.restarts, inMs });
    const timer = clock.setTimeout(() => {
      this.restartTimer = 'connecting';
      this.connect().then(
        () => {
          this.restartTimer = null;
          this.onStatus({ kind: 'ready' });
          this.pauseGoals();
        },
        () => {
          // it exited again: that exit scheduled the next try; one that never answered is killed (one still
          // looking up its binary is given up on), and its exit (or error) schedules it
          if (this.restartTimer !== 'connecting') return;
          if (this.server.proc) killTree(this.server.proc);
          else if (this.server.pending) this.server.abandon(this.server.pending, new Error('Codex took too long to start'));
          else {
            this.restartTimer = null;
            this.scheduleRestart();
          }
        },
      );
    }, inMs);
    timer.unref?.();
    this.restartTimer = timer;
  }

  /**
   * Goals that were running when Codex quit stay paused (A23) until the user resumes them.
   * @this {CodexAdapter}
   */
  pauseGoals() {
    const ids = [...this.pauseOnReconnect];
    this.pauseOnReconnect.clear();
    // the thread is not loaded after the restart, so its goal does not run on by itself
    for (const threadId of ids) this.pauseFirst(threadId).catch((error) => noteIgnored('pause a Codex goal after a restart', error));
  }
}

module.exports = { CodexConnection, RpcError, BACKOFF_MS, FALLBACK_AFTER, NATIVE_CLEANUP_WAIT_MS, NEGOTIATE_WAIT_MS, negotiatedWithin };
