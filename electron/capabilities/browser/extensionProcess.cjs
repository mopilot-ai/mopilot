// Playwright extension child-process launch specification and MCP request transport.
const { noteIgnored } = require('../../ignored.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { ToolError } = require('../contract/registry.cjs');
const { checkAct } = require('../contract/actionGuard.cjs');
const { pageUrl } = require('./extensionResults.cjs');
const { JsonReader } = require('../../transport/jsonReader.cjs');

const HOST = path.join(__dirname, 'playwrightHost.cjs');
const CALL_MS = 120_000;
const STOP_MS = 5_000;

/**
 * How one instance is started: the host script, the CLI arguments it hands @playwright/mcp, and the
 * utilityProcess options. The environment carries only what the CLI needs to find Chrome and the token.
 * @param {{ outputDir: string, profileDir?: string | null, token?: string | null, env?: Record<string, string | undefined>, platform?: string }} o
 */
function spawnSpec({ outputDir, profileDir = null, token = null, env = process.env, platform = process.platform }) {
  const args = ['--extension', '--output-dir', outputDir, '--image-responses', 'allow', '--codegen', 'none', '--no-webmcp'];
  if (profileDir) args.push('--profile-dir-name', profileDir);
  const childEnv = { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER']) if (env[k]) childEnv[k] = env[k];
  // Windows: what Playwright needs to find Chrome and a temp folder there
  if (platform === 'win32')
    for (const k of [
      'SystemRoot',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'TEMP',
      'TMP',
      'ComSpec',
    ]) {
      const key = Object.keys(env).find((x) => x.toUpperCase() === k.toUpperCase());
      if (key && env[key]) childEnv[k] = env[key];
    }
  if (token) childEnv.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
  // the Chrome comparison's scratch profile (scripts/chrome-compare): Your Chrome opens it, never the user's own
  if (env.MOPILOT_CHROME_RELAY_USER_DATA_DIR) childEnv.PWTEST_EXTENSION_USER_DATA_DIR = env.MOPILOT_CHROME_RELAY_USER_DATA_DIR;
  return { modulePath: HOST, args, options: { stdio: 'pipe', serviceName: 'MoPilot Your Chrome', cwd: outputDir, env: childEnv } };
}

/** One @playwright/mcp process and the MCP client session with it. Emits 'exit', and 'timeout' when a call never answered. */
class PlaywrightInstance extends EventEmitter {
  /** @param {{ fork: Function, spec: ReturnType<typeof spawnSpec>, clientName: string, callMs?: number, stopMs?: number }} o */
  constructor(o) {
    super();
    this.o = o;
    this.callMs = o.callMs ?? CALL_MS;
    this.stopMs = o.stopMs ?? STOP_MS;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.outputSeq = 1;
    /** @type {number | null} the output chunk taken but not yet acknowledged, while the reader holds the CLI back */
    this.unacked = null;
    this.held = false;
    /** @type {InstanceType<typeof JsonReader> | null} the CLI's output, framed by the core */
    this.reader = null;
    this.exited = false;
    /** the page the last result named */
    this.url = null;
    this.needsSnapshot = false;
    /** the modal states (an open dialog, a file chooser) Chrome named in its last result */
    /** @type {Array<{ description: string, tool: string }>} */
    this.modalStates = [];
    /** a tool call answered, so Chrome approved this connection */
    this.connected = false;
  }

  /** Whether Chrome asks the user to approve this connection (no saved token) and has not been approved yet. */
  get awaitingApproval() {
    return !this.connected && !this.o.spec.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  }

  async start() {
    const { modulePath, args, options } = this.o.spec;
    this.child = this.o.fork(modulePath, [], options);
    this.reader = new JsonReader({
      // the reader holds the CLI's next write back by not acknowledging this one
      stream: {
        pause: () => (this.held = true),
        resume: () => {
          this.held = false;
          this.#ack();
        },
      },
      onValue: (msg) => this.#onRecord(msg),
      onError: () => this.child.kill(),
    });
    // drain both pipes so the child never blocks on a full one: on Windows the host can't replace process.stdout
    // (playwrightHost.cjs wireStdio), so a stray write to it lands in this pipe, not on the parent port
    for (const pipe of [this.child.stdout, this.child.stderr])
      pipe?.on('data', () => {
        /* read and dropped */
      });
    this.child.on('message', (m) => this.#onMessage(m));
    this.child.on('exit', (code) => {
      this.exited = true;
      // what it said before it went is answered first: a reply queued behind other output still settles its call
      /** @type {InstanceType<typeof JsonReader>} */ (this.reader).finishInput(() => {
        for (const p of this.pending.values()) p.reject(new ToolError('Your Chrome stopped.', 'failed'));
        this.pending.clear();
        this.emit('exit', code);
      });
    });
    this.child.postMessage({ type: 'start', args });
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.o.clientName, version: '1.0.0' },
    });
    this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  #write(msg) {
    this.child.postMessage({ type: 'in', data: JSON.stringify(msg) + '\n' });
  }

  /** A chunk of the CLI's output, in order, acknowledged once the reader has room for more. */
  #onMessage(m) {
    if (this.exited || !m || m.type !== 'output' || !(m.data instanceof Uint8Array)) return;
    if (m.seq !== this.outputSeq) return this.child.kill();
    this.outputSeq++;
    this.unacked = m.seq;
    /** @type {InstanceType<typeof JsonReader>} */ (this.reader).push(m.data);
    if (!this.held) this.#ack();
  }

  #ack() {
    if (this.unacked === null || this.exited) return;
    const seq = this.unacked;
    this.unacked = null;
    this.child.postMessage({ type: 'out-ack', seq });
  }

  /** @param {unknown} msg */
  #onRecord(msg) {
    if (!isJsonRecord(msg)) return;
    const p = msg.id != null && msg.method == null ? this.pending.get(msg.id) : null;
    if (p) {
      this.pending.delete(msg.id);
      const error = /** @type {{ message?: string }} */ (msg.error);
      if (error) p.reject(new ToolError(error.message || 'Playwright MCP error', 'failed'));
      else p.resolve(msg.result);
    }
  }

  request(method, params) {
    if (this.exited) return Promise.reject(new ToolError('Your Chrome stopped.', 'failed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError(`Your Chrome didn't answer ${method} in time. It was cancelled, and the next call reconnects.`, 'failed'));
        // the CLI still holds the request (waiting for Chrome's approval, say): a call that answers "too late" must
        // never run after the agent was told it failed, so it is cancelled and the channel lets this instance go
        try {
          this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timed out' } });
        } catch (error) {
          // the IPC channel may already be closed; the instance is stopped below either way
          noteIgnored('cancel a Your Chrome call that timed out', error);
        }
        this.emit('timeout', method);
      }, this.callMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async listTools() {
    return ((await this.request('tools/list', {})) || {}).tools || [];
  }

  async call(name, args) {
    // a tool call stopped since it began (Stop, a harness cancel) sends nothing more to Chrome (../contract/actionGuard.cjs)
    checkAct(`${name.replace(/^browser_/, '').replace(/_/g, ' ')} in your Chrome`);
    const r = (await this.request('tools/call', { name, arguments: args || {} })) || {};
    this.connected = true;
    const url = pageUrl(r.content);
    if (url) this.url = url;
    return r;
  }

  /**
   * Asks the CLI to close (it closes its tab group), and kills it if it doesn't.
   * @returns {Promise<void>} once the CLI exited (or was killed)
   */
  stop() {
    if (!this.child || this.exited) return Promise.resolve();
    const exited = new Promise((resolve) => this.once('exit', () => resolve(undefined)));
    try {
      this.child.postMessage({ type: 'stop' });
    } catch (error) {
      // the IPC channel may already be closed; the kill timer below still stops it
      noteIgnored('ask the Your Chrome CLI to stop', error);
    }
    const t = setTimeout(() => !this.exited && this.child.kill(), this.stopMs);
    t.unref?.();
    return exited;
  }
}

module.exports = { PlaywrightInstance, spawnSpec, HOST };
