// One ACP harness process: platform-aware launch, initialization, capability negotiation and exit.
const { clock } = require('../../platform/ports/clock.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const { spawnOwned } = require('../../platform/ports/proc.cjs');
const { EventEmitter } = require('node:events');
const { StderrTail } = require('../stderrTail.cjs');
const { spawnGroup, killTree, endGroup } = require('../../platform/winbin.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { RpcPeer } = require('./rpc.cjs');
const { ISOLATED_CAPABILITIES } = require('./isolation.cjs');
/**
 * The core's spawn, with Windows .cmd shims launched through their real program, in a process group of its own so a stop
 * or an exit also ends the commands the agent ran (electron/platform/winbin.cjs)
 */
const spawn = (command, args, options) => spawnGroup(spawnOwned, command, args, options);

/** The installation's identity, including the target when a CLI is reached through a symlink. */
function binStamp(bin) {
  try {
    const real = fs.realpathSync(bin);
    const stat = fs.statSync(real, { bigint: true });
    const file = JSON.stringify([bin, real, String(stat.ino), String(stat.ctimeNs)]);
    return `${file}|${stat.size}|${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

const PROTOCOL_VERSION = 1;
const INIT_TIMEOUT_MS = 20_000;
const CLIENT_INFO = { name: 'mopilot', title: 'MoPilot', version: '0' };
const CLIENT_CAPABILITIES = { fs: { readTextFile: true, writeTextFile: true }, terminal: true, session: { promptSuggestions: {} } };

/** What an initialize result declares, flattened. Anything not declared counts as unsupported. */
function negotiate(init) {
  const a = init?.agentCapabilities ?? {};
  const sc = a.sessionCapabilities ?? {};
  return {
    protocolVersion: init?.protocolVersion ?? null,
    agent: init?.agentInfo ?? null,
    loadSession: !!a.loadSession,
    resume: !!sc.resume,
    close: !!sc.close,
    list: !!sc.list,
    fork: !!sc.fork,
    image: !!a.promptCapabilities?.image,
    audio: a.promptCapabilities?.audio === true,
    embeddedContext: !!a.promptCapabilities?.embeddedContext,
    mcp: { http: !!a.mcpCapabilities?.http, sse: !!a.mcpCapabilities?.sse },
    authMethods: Array.isArray(init?.authMethods) ? init.authMethods : [],
  };
}

/** One harness process speaking ACP on its stdio. Emits 'exit' ({code, signal, stderr}) and 'stderr' (each text chunk). */
class AcpAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param o.harness the harness id
   * @param o.command the agent's binary
   * @param [o.args] its arguments
   * @param o.env its environment
   * @param o.cwd where it starts
   * @param [o.spawnFn] replaces this file's spawn (tests)
   * @param o.onRequest (method, params) => result | Promise<result>: the agent's requests
   * @param [o.onNotification] (method, params) => void: the agent's notifications
   * @param {boolean} [o.forms] the host can own session-scoped form elicitation
   * @param {boolean} [o.isolated] it runs only chats kept apart from the coding side: told the client has no files or terminal
   */
  constructor({ harness, command, args = [], env, cwd, spawnFn = spawn, onRequest, onNotification, forms = false, isolated = false }) {
    super();
    this.harness = harness;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.spawnFn = spawnFn;
    this.onRequest = onRequest;
    this.forms = forms;
    this.isolated = isolated;
    this.onNotification = onNotification;
    this.stderr = new StderrTail(2000);
    /** @type {Promise<AcpAgent> | null} the host's entry for this agent once it started (AcpHost.agent) */
    this.entry = null;
    this.init = null;
    /** @type {any} optional native catalog, replaced by a session's own reported models */
    this.initialModels = null;
    /** @type {ReturnType<typeof negotiate> | null} what initialize() negotiated */
    this.caps = null;
    /** @type {InstanceType<typeof RpcPeer> | null} the connection start() opens */
    this.peer = null;
    this.exited = null;
  }
  get pid() {
    return this.proc?.pid ?? null;
  }
  start() {
    // when this process started: a config written later reaches it only after a restart (electron/harness/routes.cjs)
    this.startedAt = clock.now();
    this.binaryStamp = binStamp(this.command);
    this.proc = this.spawnFn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], lines: {} });
    const peer = new RpcPeer({
      input: this.proc.stdout,
      output: this.proc.stdin,
      onRequest: this.onRequest,
      onNotification: this.onNotification,
      onFailure: (error) => {
        gone(null, null, error.message);
        killTree(proc);
      },
    });
    this.peer = peer;
    // the agent exited: its exit handler closes the peer, which fails what still waits
    this.proc.stdin.on('error', (error) => noteIgnored(`write to ${this.harness}`, error, ['EPIPE']));
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (d) => {
      this.stderr.push(d);
      this.emit('stderr', d);
    });
    const gone = (code, signal, error) => {
      if (this.exited) return;
      this.exited = { code, signal, error: error ?? null, stderr: this.stderr.text };
      peer.close(new Error(error ?? `${this.harness} exited${code != null ? ` (${code})` : signal ? ` (${signal})` : ''}`));
      this.emit('exit', this.exited);
    };
    this.proc.on('error', (e) => gone(null, null, String(e?.message ?? e)));
    const proc = this.proc;
    this.proc.on('exit', (code, signal) => {
      // whatever it started and left running goes with it (a stop already signalled its group)
      endGroup(proc);
      peer.finishInput(() => gone(code, signal));
    });
  }
  /** initialize, v1 only. Rejects when the agent picks another version. */
  async initialize() {
    const res = await this.#rpc().request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          ...(this.isolated ? ISOLATED_CAPABILITIES : CLIENT_CAPABILITIES),
          ...(this.forms ? { elicitation: { form: {} } } : {}),
        },
        clientInfo: CLIENT_INFO,
      },
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    if (res?.protocolVersion !== PROTOCOL_VERSION)
      throw new Error(`${this.harness} speaks ACP v${res?.protocolVersion ?? '?'}; MoPilot needs v${PROTOCOL_VERSION}`);
    this.init = res;
    this.caps = negotiate(res);
    return res;
  }
  /** @returns {InstanceType<typeof RpcPeer>} the connection: nothing talks to the agent before start() opens it */
  #rpc() {
    return /** @type {InstanceType<typeof RpcPeer>} */ (this.peer);
  }
  request(method, params, o) {
    return this.#rpc().request(method, params, o);
  }
  notify(method, params) {
    this.#rpc().notify(method, params);
  }
  kill() {
    this.peer?.close(new Error(`${this.harness} stopped`));
    try {
      this.proc?.stdin.end();
    } catch (error) {
      // stdin may already be closed
      noteIgnored(`close ${this.harness}'s input`, error);
    }
    const p = this.proc;
    clock
      .setTimeout(() => {
        try {
          if (!this.exited) killTree(p);
        } catch (error) {
          // the process may already be gone
          noteIgnored(`stop ${this.harness}`, error, ['ESRCH']);
        }
      }, 2000)
      .unref?.();
  }
}

module.exports = { AcpAgent, binStamp, negotiate, spawn, PROTOCOL_VERSION, CLIENT_CAPABILITIES };
