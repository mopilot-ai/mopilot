// Who may use the model relay (electron/identity/accounts/relay.cjs): only the Codex app-server process itself, checked once per
// connection with lsof (POSIX). Not the processes it starts (MCP servers, the commands a model runs), which could
// otherwise spend every pooled account; Codex's model traffic comes from the app-server alone. An npm install runs
// codex.js under node, and the native codex it starts is the app-server then. Codex logs the URLs it calls, so the
// relay's random path alone would not keep other local programs out (#2144).
const path = require('node:path');
const { proc } = require('../../platform/ports/proc.cjs');
const { tcpPeerPid, run, PEER_NOT_FOUND } = require('../../capabilities/httpMcp.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How many peer checks (lsof, ps) run at once; the rest wait their turn. */
const MAX_CHECKS = 4;

/** A process's parent pid and executable, from ps; null when it is gone. */
async function processInfo(/** @type {number} */ pid, exec = proc.execFile) {
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(await run('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], exec));
  return m ? { ppid: Number(m[1]), name: path.basename(m[2]) } : null;
}

/**
 * Null when the process at the far end of `socket` is the app-server (`harnessPid`), or the native codex an npm
 * launcher (node running codex.js) started as it; otherwise why not (PEER_NOT_FOUND when lsof could not tell).
 * @param {{ socket: import('node:net').Socket, harnessPid: number | undefined, execFile?: typeof proc.execFile }} o
 */
async function appServerPeer({ socket, harnessPid, execFile: exec = proc.execFile }) {
  if (!Number.isInteger(harnessPid)) return 'Codex is not running';
  const peer = await tcpPeerPid(socket, exec);
  if (typeof peer === 'string' || peer === harnessPid) return typeof peer === 'string' ? peer : null;
  if (peer === null) return 'the connecting process has no pid';
  const [info, server] = await Promise.all([processInfo(peer, exec), processInfo(/** @type {number} */ (harnessPid), exec)]);
  if (info && info.ppid === harnessPid && info.name === 'codex' && /^(node|bun)$/.test(server?.name ?? '')) return null;
  return `process ${peer} is not the Codex app-server`;
}

class RelayPeers {
  /**
   * @param {() => number | number[] | undefined} pid the app-servers' pids now (none while none runs; MoMo's runs beside the main one)
   * @param {{ verifyPeer?: typeof appServerPeer, platform?: string }} [o] the peer check and platform, for tests
   */
  constructor(pid, { verifyPeer = appServerPeer, platform = process.platform } = {}) {
    this.pid = pid;
    this.verifyPeer = verifyPeer;
    this.platform = platform;
    /** @type {WeakMap<import('node:net').Socket, Promise<boolean | null>>} connection -> its answer, checked once */
    this.checks = new WeakMap();
    /** checks running, and the ones waiting for a turn */
    this.running = 0;
    /** @type {(() => void)[]} */
    this.waiting = [];
  }

  /** Runs `fn` when fewer than MAX_CHECKS run. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  async #bounded(fn) {
    if (this.running >= MAX_CHECKS) await new Promise((resolve) => this.waiting.push(() => resolve(undefined)));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /**
   * Whether `socket`'s far end is the app-server: true, false, or null when that could not be
   * told (lsof printed nothing or failed on a loaded machine), which the relay answers with a retryable error rather
   * than a refusal, and asks again on the connection's next request. Windows has no lsof: there the random path is
   * the only gate. Each answer is recorded.
   * @param {import('node:net').Socket} socket
   * @returns {Promise<boolean | null>}
   */
  admits(socket) {
    if (this.platform === 'win32') return Promise.resolve(true);
    /** @type {Promise<boolean | null> | undefined} */
    let check = this.checks.get(socket);
    if (!check) {
      // no app-server running: verifyTcpPeer says so (no harness process), and nothing is taken
      check = this.#bounded(() => this.#anyServer(socket)).then(
        (why) => {
          if (!why) return true;
          noteIgnored('take a model relay connection', new Error(why));
          return why === PEER_NOT_FOUND ? this.#unsure(socket) : false;
        },
        (error) => (noteIgnored('check who connected to the model relay', error), this.#unsure(socket)),
      );
      this.checks.set(socket, check);
    }
    return check;
  }

  /** Null when the far end is one of the app-servers (or a process it started), else why not (the last answer). */
  async #anyServer(/** @type {import('node:net').Socket} */ socket) {
    const listed = [this.pid()].flat();
    // none running: the check says so, and nothing is taken
    const pids = listed.length ? listed : [undefined];
    /** @type {string | null} */
    let why = null;
    for (const harnessPid of pids) {
      why = await this.verifyPeer({ socket, harnessPid });
      if (!why) return null;
    }
    return why;
  }

  /** @param {import('node:net').Socket} socket @returns {null} */
  #unsure(socket) {
    this.checks.delete(socket);
    return null;
  }
}

module.exports = { RelayPeers, appServerPeer, MAX_CHECKS };
