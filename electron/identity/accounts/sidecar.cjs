// Account-scoped Codex app-server process, protocol, idle shutdown and bounded requests.
const { spawnOwned } = require('../../platform/ports/proc.cjs');
const os = require('node:os');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { JsonReader } = require('../../transport/jsonReader.cjs');
const shellEnv = require('../../platform/env.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { withTimeout: timed } = require('../../platform/timeout.cjs');
const { spawnGroup, killTree, endGroup } = require('../../platform/winbin.cjs');

const SIDECAR_IDLE_MS = 45_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Rejects if `p` doesn't settle in time, so a stuck app-server can't wedge a switch or startup. */
const withTimeout = (p, what) => timed(p, REQUEST_TIMEOUT_MS, `${what} timed out`);

/** @typedef {import('node:child_process').ChildProcess & { stdin: import('node:stream').Writable, stdout: import('node:stream').Readable }} PipedChild */

class Sidecar {
  /**
   * @param {string | Promise<string>} bin the binary, or a promise of it while it is looked up: the process starts
   * once it answers, and requests wait for it as they wait for initialize
   */
  constructor(bin, home, onExit, clientInfo) {
    this.home = home;
    this.pending = new Map();
    this.notify = new Set();
    this.nextId = 1;
    this.reader = null;
    this.onExit = onExit;
    /** stays up past the idle timeout (a browser sign-in in progress) */
    this.keepAlive = false;
    /** @type {PipedChild | null} */
    this.proc = null;
    /** the binary is still being looked up: no process yet, and close() means none starts */
    this.starting = typeof bin !== 'string';
    // a failed spawn (ENOENT, EACCES) emits 'error' and 'close' but never 'exit': each counts as the end
    let done;
    this.exited = new Promise((r) => (done = r));
    this.end = () => {
      if (!done) return;
      done();
      done = null;
      this.starting = false;
      this.reader?.close();
      clearTimeout(this.idle);
      for (const p of this.pending.values()) p.reject(new Error('Codex exited'));
      this.pending.clear();
      this.proc = null;
      this.onExit?.();
    };
    const handshake = () =>
      this.request('initialize', { clientInfo, capabilities: { experimentalApi: true } }).then(() => this.write({ method: 'initialized' }));
    if (typeof bin === 'string') {
      this.launch(bin);
      this.ready = handshake();
    } else
      this.ready = Promise.resolve(bin)
        .then((b) => {
          // closed while the binary was looked up: nothing is started
          if (!this.starting) throw new Error('Codex exited');
          this.starting = false;
          this.launch(b);
        })
        // no binary, or one that could not be launched, ends it as an exit would
        .then(handshake, (error) => {
          this.end();
          throw error;
        });
    // callers await this.ready and get the rejection themselves; this only keeps it from being unhandled
    this.ready.catch((error) => noteIgnored('start a Codex account helper', error));
    this.touch();
  }
  /** Up, or on its way up: a caller reuses it rather than starting another. */
  get running() {
    return !!this.proc || this.starting;
  }
  /** @param {string} bin */
  launch(bin) {
    const env = { ...shellEnv.childEnv(), CODEX_HOME: this.home };
    // stdin and stdout are pipes; in a process group of its own, so closing it also ends anything it started
    const proc = /** @type {PipedChild} */ (
      spawnGroup(spawnOwned, bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], lines: {}, env, cwd: os.homedir() })
    );
    this.proc = proc;
    // a closed pipe (EPIPE) means the process exited, and its exit handler cleans up
    proc.stdin.on('error', (error) => noteIgnored('write to a Codex account helper', error, ['EPIPE']));
    const reader = new JsonReader({
      stream: proc.stdout,
      onValue: (m) => {
        if (this.proc !== proc || !isJsonRecord(m)) return;
        if (m.id != null && !m.method) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          const error = /** @type {{ message?: string }} */ (m.error);
          if (p) error ? p.reject(new Error(error.message || 'Request failed')) : p.resolve(m.result);
        } else if (m.method && m.id != null) {
          // This client takes no server requests (approvals etc. can't happen without threads).
          this.write({ id: m.id, error: { code: -32601, message: 'Not supported' } });
        } else if (m.method) for (const h of this.notify) h(m.method, m.params);
      },
      onError: () => {
        this.end();
        killTree(proc);
      },
    });
    this.reader = reader;
    proc.stdout.on('data', (chunk) => reader.push(chunk));
    proc.on('exit', () => {
      endGroup(proc);
      reader.finishInput(this.end);
    });
    proc.on('close', () => reader.finishInput(this.end));
    proc.on('error', () => this.proc && !this.proc.pid && this.end());
  }
  write(obj) {
    if (this.proc) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('Codex exited'));
      this.touch();
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  async call(method, params) {
    await withTimeout(this.ready, 'Codex startup');
    return withTimeout(this.request(method, params), method);
  }
  touch() {
    clearTimeout(this.idle);
    if (this.keepAlive) return;
    this.idle = setTimeout(() => this.close(), SIDECAR_IDLE_MS);
  }
  close() {
    clearTimeout(this.idle);
    this.reader?.close();
    if (this.proc) killTree(this.proc);
    // one still looking up its binary ends now
    else if (this.starting) this.end();
    return this.exited;
  }
}

module.exports = { Sidecar, withTimeout };
