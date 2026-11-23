// MoMo's Codex app-server (#2308): a second `codex app-server` whose CODEX_HOME is MoMo's own (codexMomoHome.cjs), so no
// AGENTS.md, skills, hooks or memories the user keeps for their coding agents reach MoMo's chats. Codex reads those from
// CODEX_HOME for the whole process, with no switch per thread. It sits behind the main AppServer's send: an isolated
// chat's threads (a thread/start marked ISOLATED_THREAD, then every request naming one of its threads) go to it, and
// everything else stays on the main one, so the adapter, the leases, prewarm and the accounts see one server. It starts
// with the first such request, initialized as the main one was and signed in to the active account's tokens (and again
// on every token sign-in or sign-out the main one gets; never a browser sign-in or an API key, which Codex would keep in
// MoMo's home); it goes with the main one's stop and exit. Its server requests, and the notifications naming them, are
// told apart by their id (`momo:<process>:`); its notifications that name no thread (account, usage, process events)
// are the main one's to tell. When
// it exits alone, its open requests fail, its running turns end failed and its threads close, so nothing waits on it,
// and the next request starts it again.
// A Host's credential lanes (codexLanes.cjs, #4667) reuse it: a server of its own per credential, with an id prefix of its own, signing in as no one's follower.
const { ISOLATED_THREAD } = require('./codexIsolation.cjs');
const { dispatchChecks, forkAnswers } = require('./codexOutgoing.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');

/** Its server requests' ids as the main connection carries them. */
const PREFIX = 'momo:';
/** The main app-server's sign-ins this one follows: to an account's tokens, and out. */
const follows = (obj) =>
  obj.method === 'account/logout' || (obj.method === 'account/login/start' && obj.params?.type === 'chatgptAuthTokens');
const OPENS = new Set(['thread/start', 'thread/fork']);
/** The requests after which a thread is no one's to keep: a chat that ended or was deleted must not leave its thread held by the process. */
const ENDS = new Set(['thread/archive', 'thread/unsubscribe', 'thread/delete']);
const EXITED = 'Codex app-server exited';
const SETUP_WAIT_MS = 30_000;
const SETUP_TIMEOUT = -32098;

class IsolatedServer {
  /**
   * @param {object} o
   * @param {InstanceType<typeof import('./codexProcess.cjs').AppServer>} o.main the app-server every other thread runs on
   * @param {InstanceType<typeof import('./codexProcess.cjs').AppServer>} o.server this one's process, with CODEX_HOME set to MoMo's home
   * @param {(threadId: string) => boolean} o.owns the thread is an isolated chat's (CodexIsolation.applies)
   * @param {() => void} o.prepare makes its home ready, before each start (codexMomoHome.cjs)
   * @param {() => Promise<object | null>} o.login the active account's account/login/start params, or null
   * @param {(threadId: string) => Promise<unknown>} [o.adopt] before a thread/resume here: brings in a thread made before this one had a home
   * @param {string} [o.prefix] what its server requests' ids start with on the main connection (one per server, so two never share an id)
   * @param {boolean} [o.follows] whether it signs in and out as the main one does (MoMo's does; a server of its own credential never does)
   * @param {(obj: { params?: any }) => boolean} [o.mine] replaces the rule for which requests are this one's
   * @param {() => number} [o.now] the clock its idleness is told by (default: the platform's)
   * @param {boolean} [o.attach] whether it takes the main one's `isolated` slot (a set of servers takes it for them)
   */
  constructor(o) {
    this.main = o.main;
    this.server = o.server;
    this.owns = o.owns;
    this.prepare = o.prepare;
    this.login = o.login;
    this.adopt = o.adopt ?? (async () => false);
    this.prefix = o.prefix ?? PREFIX;
    /** its own requests' ids (the handshake, sign-ins): never on the main connection, but told apart from a server's */
    this.ownPrefix = o.prefix ? `${o.prefix}own:` : 'momo-own:';
    this.signsWithMain = o.follows !== false;
    /** the clock `activeAt` is read from: the reaper's own, so a lane's idleness and the reaper's `now` are the same time */
    this.now = o.now ?? (() => clock.now());
    if (o.mine) this.mine = o.mine;
    /** threads started, forked or loaded on it */
    this.threads = new Set();
    /** thread -> its running turn */
    this.turns = new Map();
    /** its client requests not answered yet: id -> what they were */
    this.sent = new Map();
    /** thread -> its adoption under way (a resume waits for it, and so does anything asked of the thread after it) */
    this.adopting = new Map();
    /** its own requests (the handshake, sign-ins): id -> settle */
    this.own = new Map();
    this.seq = 0;
    /** when a request went to it or a message came from it last (the clock of whoever reaps it when idle); 0: never */
    this.activeAt = 0;
    /** its process, counted: an id from an earlier one never reaches the next */
    this.gen = 0;
    /** sign-ins it got, counted: the start's own sign-in gives way to one that came while it read the account */
    this.logins = 0;
    /** null: not started; lines waiting for the handshake; or 'open' */
    this.state = /** @type {null | any[] | 'open'} */ (null);
    this.setupTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined);
    /** the main app-server's initialize params, repeated for this one */
    this.initParams = null;
    // its messages are read as the main one's: the accounts and server requests answer them the same way
    this.server.intercepts = this.main.intercepts;
    this.server.ahead = this.main.ahead;
    this.server.inbound = (m) => this.inbound(m);
    /** whether it hears its process yet: from its first start on */
    this.hooked = false;
    if (o.attach !== false) this.main.isolated = this;
  }

  /** Whether a thread runs here. */
  holds(threadId) {
    return typeof threadId === 'string' && (this.threads.has(threadId) || this.owns(threadId));
  }

  /** Whether a request to the app-server is this one's: a new isolated thread, or one naming an isolated chat's thread. */
  mine(obj) {
    const p = obj.params ?? {};
    return p[ISOLATED_THREAD] === true || this.holds(p.threadId);
  }

  /** The process a thread's request goes to, started now when it is this one (a thread's tool session names it). */
  pidFor(params) {
    if (!this.mine({ params })) return this.main.proc?.pid;
    this.ensure();
    return this.server.proc?.pid;
  }

  /** Whether its process runs now (asking it something starts it, which a check of what it holds must not). */
  running() {
    return this.state === 'open' && !!this.server.proc;
  }

  /** Lets go of every thread it keeps loaded: its process ends, and the adapter hears each thread close. The next request starts it again. */
  recycle(error) {
    this.lost(error);
    this.server.stop();
  }

  pid() {
    return this.server.proc?.pid;
  }

  /** Its process now running, as the list a set of servers gives (codexLanes.cjs). */
  pids() {
    return [this.server.proc?.pid];
  }

  /** The main AppServer's send: true when the message went here instead. */
  take(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.method && obj.id == null) return false;
    if (!obj.method) {
      if (typeof obj.id !== 'string' || !obj.id.startsWith(this.prefix)) return false;
      // an answer to one of its server requests; one its earlier process asked is no one's now
      const id = this.theirs(obj.id);
      if (id !== undefined) this.deliver({ ...obj, id });
      return true;
    }
    if (obj.method === 'initialize') this.initParams = obj.params;
    // the main one signs in or out: so does this one, when it runs
    if (this.signsWithMain && follows(obj) && this.state) {
      this.logins++;
      this.request(obj.method, obj.params).catch((e) => noteIgnored("sign MoMo's Codex in", e));
    }
    if (!this.mine(obj)) return false;
    const dispatch = dispatchChecks.get(obj);
    this.sent.set(obj.id, {
      method: obj.method,
      threadId: obj.params?.threadId,
      active: forkAnswers.get(obj)?.active,
      background: dispatch?.background,
    });
    if (dispatch) {
      const check = dispatch.check;
      dispatch.check = () => {
        const current = check();
        if (!current) this.sent.delete(obj.id);
        return current;
      };
    }
    const threadId = obj.params?.threadId;
    let waiting = typeof threadId === 'string' ? this.adopting.get(threadId) : undefined;
    if (!waiting && obj.method === 'thread/resume' && typeof threadId === 'string') {
      // a thread made in the user's home comes into MoMo's first; never resumed on the user's server.
      // Only a MoMo chat's thread (`owns`): nothing else of the user's is ever copied in
      waiting = Promise.resolve(this.owns(threadId) ? this.adopt(threadId) : false)
        .catch((e) => noteIgnored("bring a MoMo chat's earlier Codex thread in", e))
        .finally(() => this.adopting.delete(threadId));
      this.adopting.set(threadId, waiting);
    }
    if (waiting) {
      // what follows a resume on the same thread goes out after it, in the order it was asked
      void waiting.then(() => this.sent.has(obj.id) && this.deliver(obj));
      return true;
    }
    this.deliver(obj);
    return true;
  }

  /** Whether it has a request on its way or a thread coming in: not a moment to let its process go. */
  busy() {
    // An expired fork still accepts a late answer for cleanup, while idle processes can be recycled.
    for (const request of this.sent.values()) if (!request.background && request.active?.() !== false) return true;
    return this.adopting.size > 0;
  }

  deliver(msg) {
    this.activeAt = this.now();
    this.ensure();
    if (this.state === 'open') return this.server.send(msg);
    /** @type {any[]} */ (this.state).push(msg);
  }

  /** Starts it, once: initialized as the main one was, then signed in, then what waited goes out. */
  ensure() {
    if (this.state) return;
    if (!this.hooked) {
      this.hooked = true;
      this.server.listeners.add((evt) => (evt.kind === 'message' ? this.main.emit(evt) : this.lifecycle(evt)));
    }
    try {
      this.prepare();
    } catch (e) {
      // without its own home it never starts: what was asked of it fails now, and the next request tries again
      this.state = [];
      return queueMicrotask(() => this.failStart(e));
    }
    this.state = [];
    this.gen++;
    const started = this.state;
    const logins = this.logins;
    // A stuck initialize or sign-in must not keep later requests queued on this process.
    const timer = clock.setTimeout(
      () => this.recycle({ code: SETUP_TIMEOUT, message: 'Codex app-server sign-in or initialization timed out' }),
      SETUP_WAIT_MS,
    );
    timer.unref();
    this.setupTimer = timer;
    // every failure below is caught: what waited goes out whatever the handshake did
    void this.request('initialize', this.initParams)
      .then(() => {
        if (this.state !== started) return;
        this.server.send({ method: 'initialized' });
        // a sign-in that came meanwhile went out after initialize, and is newer than what was read here
        return Promise.resolve(this.login()).then(
          (params) => params && this.state === started && this.logins === logins && this.request('account/login/start', params),
        );
      })
      // a failed sign-in still opens it: its turns then say Codex's own reason
      .catch((e) => noteIgnored("start MoMo's Codex", e))
      .then(() => {
        if (this.state !== started) return;
        this.state = 'open';
        for (const msg of started) this.server.send(msg);
      })
      .finally(() => clock.clearTimeout(timer));
  }

  /** Its home couldn't be made ready: every request waiting for it fails with why. */
  failStart(e) {
    const waiting = /** @type {any[]} */ (this.state);
    this.state = null;
    for (const msg of waiting) {
      if (!msg.method) continue;
      this.sent.delete(msg.id);
      this.main.emit({
        kind: 'message',
        msg: { id: msg.id, error: { code: -1, message: `Couldn't start MoMo's Codex: ${messageOf(e)}` } },
      });
    }
  }

  request(method, params) {
    const id = `${this.ownPrefix}${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.own.set(id, { resolve, reject });
      this.server.send({ id, method, params: params ?? {} });
    });
  }

  /** Each of its messages, before anyone reads it. */
  inbound(m) {
    this.activeAt = this.now();
    if (m.id != null && !m.method) {
      const own = this.own.get(m.id);
      if (own) {
        this.own.delete(m.id);
        if (m.error) own.reject(new Error(m.error.message));
        else own.resolve(m.result);
        return null;
      }
      const sent = this.sent.get(m.id);
      this.sent.delete(m.id);
      if (sent && !m.error) this.answered(sent, m.result);
      return m;
    }
    if (m.id != null) return { ...m, id: this.ours(m.id) };
    const p = m.params ?? {};
    // the notification that one of its server requests was answered or withdrawn names it as the main connection does
    const out = p.requestId != null ? { ...m, params: { ...p, requestId: this.ours(p.requestId) } } : m;
    const threadId = p.threadId ?? p.thread?.id;
    if (typeof threadId !== 'string') return null;
    if (m.method === 'thread/started') this.threads.add(threadId);
    else if (m.method === 'turn/started') this.turns.set(threadId, p.turn?.id);
    else if (m.method === 'turn/completed') this.turns.delete(threadId);
    else if (m.method === 'thread/closed') {
      this.threads.delete(threadId);
      this.turns.delete(threadId);
    }
    return out;
  }

  answered(sent, result) {
    if (OPENS.has(sent.method) && typeof result?.thread?.id === 'string') this.threads.add(result.thread.id);
    if (sent.method === 'thread/resume') this.threads.add(sent.threadId);
    if (ENDS.has(sent.method) && sent.threadId) {
      this.threads.delete(sent.threadId);
      this.turns.delete(sent.threadId);
    }
  }

  lifecycle(evt) {
    if (evt.kind === 'exit' || (evt.kind === 'error' && !this.server.proc)) this.lost();
  }

  /** It exited alone: nothing waits on it any more, and the next request starts it again. */
  lost(error = { code: -1, message: EXITED }) {
    const requests = [...this.sent.keys()];
    const turns = [...this.turns];
    const threads = [...this.threads];
    this.reset();
    // read as its own messages are: the accounts and server requests hear them too
    const tell = (msg) => !this.main.intercepts.handle(msg) && this.main.emit({ kind: 'message', msg });
    for (const id of requests) tell({ id, error });
    for (const [threadId, id] of turns)
      tell({ method: 'turn/completed', params: { threadId, turn: { id, status: 'failed', error: { message: EXITED } } } });
    for (const threadId of threads) tell({ method: 'thread/closed', params: { threadId } });
  }

  /** Its id as the main connection carries it. */
  ours(id) {
    return `${this.prefix}${this.gen}:${JSON.stringify(id)}`;
  }

  /** Its own id back from one the main connection carries, or undefined when its earlier process asked it. */
  theirs(carried) {
    const rest = carried.slice(this.prefix.length);
    const at = rest.indexOf(':');
    return rest.slice(0, at) === String(this.gen) ? JSON.parse(rest.slice(at + 1)) : undefined;
  }

  reset() {
    clock.clearTimeout(this.setupTimer);
    this.setupTimer = undefined;
    for (const { reject } of this.own.values()) reject(new Error(EXITED));
    this.own.clear();
    this.sent.clear();
    this.turns.clear();
    this.threads.clear();
    this.state = null;
  }

  /** Goes with the main one's stop or exit: the adapter ends everything then, so nothing is told here. */
  stop() {
    this.reset();
    this.server.stop();
  }
}

module.exports = { IsolatedServer, PREFIX, SETUP_TIMEOUT };
