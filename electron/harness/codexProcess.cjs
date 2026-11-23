// The `codex app-server` process and its JSON-RPC pipe: one line per message, main's intercept chain ahead of the adapter.
const { clock } = require('../platform/ports/clock.cjs');
const { spawnOwned } = require('../platform/ports/proc.cjs');
const { StderrTail } = require('./stderrTail.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { JsonReader } = require('../transport/jsonReader.cjs');
const os = require('node:os');
const { InterceptChain } = require('../capabilities/contract/serverRequests.cjs');
const { spawnGroup, killTree, endGroup } = require('../platform/winbin.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { dispatchChecks, forkAnswers, acceptAnswer } = require('./codexOutgoing.cjs');

class AppServer {
  /**
   * @param {object} [o]
   * @param [o.findBin] () => path, or a promise of it while it is looked up
   * @param [o.copies] the installed copies (electron/app/codexServer.cjs): copyOf(bin) => { copy, pinned } names one,
   *   and fallBack(bin) => the copy the next start runs instead of a default `bin` that keeps quitting, or null
   * @param [o.env] () => env
   * @param [o.args] () => the arguments after `app-server` for the next start (a Host's credential store)
   * @param [o.onCrashReport] (code, signal, stderr) => void: the server exited unexpectedly
   * @param [o.spawn] replaces the core's spawn (tests)
   * @param [o.inbound] (msg) => msg | null: each message as it arrives, before anyone reads it (null drops it)
   */
  constructor(o = {}) {
    this.spawn = o.spawn ?? spawnOwned;
    this.findBin = o.findBin ?? (() => 'codex');
    this.copies = o.copies ?? null;
    this.env = o.env ?? (() => process.env);
    this.args = o.args ?? (() => []);
    this.onCrashReport =
      o.onCrashReport ??
      (() => {
        /* no listener */
      });
    /** @type {(import('../platform/winbin.cjs').StoppableChild & import('node:child_process').ChildProcessWithoutNullStreams) | null} */
    this.proc = null;
    /**
     * A start whose binary is still being looked up: the writes waiting in order, and the process it spawned
     * once it has (so whoever began it can still end that one)
     * @type {{ queue: (() => void)[], proc: AppServer['proc'] } | null}
     */
    this.pending = null;
    this.reader = null;
    this.listeners = new Set();
    /** (text) => void: each piece of the process's stderr as it arrives (the Remote Control link reads its warnings) */
    this.stderrListeners = new Set();
    this.stderrTail = new StderrTail(4000);
    this.status = 'stopped';
    /** @type {string | null} the binary the last start ran (whether it is still running or not) */
    this.bin = null;
    this.startedAt = 0;
    /**
     * Config every thread starts, resumes or forks with (the account relay's addresses, electron/identity/accounts/relay.cjs). It goes to
     * the app-server over stdin with each request (codexConnection.cjs), never on its command line, where any local
     * process, another user's included, can read it.
     * @type {Record<string, string> | null}
     */
    this.threadConfig = null;
    // main's handlers for app-server messages, ahead of the adapter (accounts, server requests)
    this.intercepts = new InterceptChain();
    /**
     * Readers that see each message before the intercept chain and never consume it: the adapter's answer hooks,
     * so what an answer starts (a switch's new thread) is claimed for its chat before any handler resolves it
     */
    this.ahead = new Set();
    this.inbound = o.inbound ?? null;
    /** @type {Map<string, import('./codexOutgoing.cjs').ForkAnswer>} */
    this.forkAnswers = new Map();
    /**
     * The second app-server some threads run on (MoMo's, codexIsolatedServer.cjs), or a set of them, one per credential (codexLanes.cjs),
     * behind this one's send: it takes what is its own and goes with this one's stop and exit. Null: none.
     * @type {InstanceType<typeof import('./codexIsolatedServer.cjs').IsolatedServer> | InstanceType<typeof import('./codexLanes.cjs').CodexLanes> | null}
     */
    this.isolated = null;
  }
  /** The process a thread's request goes to (a thread's tool session names it): MoMo's for one of its threads. */
  pidFor(params) {
    return this.isolated ? this.isolated.pidFor(params) : this.proc?.pid;
  }
  /** The processes running now, this one's first: every app-server a thread may run on. */
  pids() {
    return [this.proc?.pid, ...(this.isolated?.pids() ?? [])].filter((pid) => Number.isInteger(pid));
  }
  start() {
    if (this.proc || this.pending) return;
    const bin = this.findBin();
    this.status = 'starting';
    this.reader?.close();
    this.reader = null;
    this.stderrTail = new StderrTail(4000);
    if (typeof bin === 'string') return this.launch(bin);
    const pending = { queue: /** @type {(() => void)[]} */ ([]), proc: /** @type {AppServer['proc']} */ (null) };
    this.pending = pending;
    Promise.resolve(bin)
      .then((b) => {
        // stopped (or given up on) meanwhile: nothing is spawned
        if (this.pending !== pending) return;
        // a spawn that throws leaves it pending, and is given up on below
        this.launch(b);
        this.pending = null;
        pending.proc = this.proc;
        for (const write of pending.queue) write();
      })
      .catch((error) => this.abandon(pending, error));
  }
  /**
   * Gives up on a start still looking up its binary (a lookup that failed, or one that took too long): its queued
   * lines are dropped, and listeners hear an error as from a binary that couldn't be spawned, so the next start
   * looks again.
   * @param {NonNullable<AppServer['pending']>} pending
   */
  abandon(pending, error) {
    if (this.pending !== pending) return;
    // a spawn that threw part way may have left its process: it is ended, so the next start spawns afresh
    const proc = this.proc;
    this.proc = null;
    this.reader?.close();
    this.reader = null;
    if (proc) killTree(proc);
    this.pending = null;
    this.status = 'exited';
    this.emit({ kind: 'error', error: String(error?.message ?? error) });
  }
  /** @param {string} bin */
  launch(bin) {
    this.bin = bin;
    // on Windows an npm .cmd shim is launched through its real program (electron/platform/winbin.cjs)
    // all three stdio streams are pipes; in a process group of its own, so a stop or a crash also ends its commands
    const proc =
      /** @type {import('../platform/winbin.cjs').StoppableChild & import('node:child_process').ChildProcessWithoutNullStreams} */ (
        spawnGroup((...a) => this.spawn(...a), bin, ['app-server', ...this.args()], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // the core frames stdout into lines (electron/platform/coreChild.cjs)
          lines: {},
          env: this.env(),
          cwd: os.homedir(),
        })
      );
    this.proc = proc;
    // when this process started: a config written later reaches it only after a restart (electron/harness/routes.cjs)
    this.startedAt = clock.now();
    proc.stdin.on('error', () => {
      /* the process exited; its exit handler cleans up */
    });
    const reader = new JsonReader({
      stream: proc.stdout,
      onValue: (value) => {
        if (this.proc !== proc || !isJsonRecord(value)) return;
        const answer = acceptAnswer(this.forkAnswers, value);
        const msg = this.inbound ? this.inbound(answer) : answer;
        if (!msg) return;
        this.readAhead(msg);
        if (!this.intercepts.handle(msg)) this.emit({ kind: 'message', msg });
      },
      onError: (error) => {
        if (this.proc !== proc) return;
        this.emit({ kind: 'error', error: error.message });
        killTree(proc);
      },
    });
    this.reader = reader;
    proc.stdout.on('data', (chunk) => this.proc === proc && reader.push(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      if (this.proc !== proc) return;
      this.stderrTail.push(d);
      for (const l of this.stderrListeners) l(d);
    });
    proc.on('exit', (code, signal) => {
      // whatever it started and left running goes with it (a stop already signalled its group)
      endGroup(proc);
      reader.finishInput(() => {
        // a process stop() already replaced is not news
        if (this.proc !== proc) return;
        this.proc = null;
        this.reader = null;
        this.status = 'exited';
        this.forkAnswers.clear();
        const stderr = this.stderrTail.text;
        // killTree marks a process stopped on purpose (taskkill exits it with code 1 on Windows)
        if (!proc.stopped && (code || (signal && signal !== 'SIGTERM'))) this.onCrashReport(code, signal, stderr);
        // its threads' second app-server goes with it: everything is started again together
        this.isolated?.stop();
        this.emit({ kind: 'exit', code, signal, stderr });
      });
    });
    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      // a binary that couldn't be spawned leaves no process: let the next start try again (and report again)
      if (proc.pid === undefined) {
        reader.close();
        this.proc = null;
        this.status = 'exited';
      }
      this.emit({ kind: 'error', error: String(err && err.message) });
    });
    this.status = 'running';
  }
  /** Runs the readers ahead of the intercept chain; one that throws never costs the message. */
  readAhead(msg) {
    for (const fn of this.ahead)
      try {
        fn(msg);
      } catch (error) {
        noteIgnored('read an app-server message ahead of the intercept chain', error);
      }
  }
  emit(evt) {
    for (const l of this.listeners) l(evt);
  }
  send(obj) {
    // a thread of the second app-server goes there (codexIsolatedServer.cjs)
    if (this.isolated?.take(obj)) return;
    if (!this.proc) this.start();
    const line = JSON.stringify(obj) + '\n';
    // a start still looking up its binary writes these once it has spawned
    const write = () => {
      if (dispatchChecks.get(obj)?.check() === false) return;
      const fork = forkAnswers.get(obj);
      if (fork) this.forkAnswers.set(obj.id, fork);
      this.proc?.stdin.write(line);
    };
    if (this.pending) this.pending.queue.push(write);
    else write();
  }
  /** Stop on purpose: listeners hear 'stopped' now, never the old process's exit; a start still looking up spawns nothing. */
  stop() {
    this.forkAnswers.clear();
    this.isolated?.stop();
    const proc = this.proc;
    const pending = this.pending;
    this.proc = null;
    this.reader?.close();
    this.reader = null;
    this.pending = null;
    this.status = 'stopped';
    if (proc) killTree(proc);
    if (proc || pending) this.emit({ kind: 'stopped' });
  }
}

module.exports = { AppServer };
