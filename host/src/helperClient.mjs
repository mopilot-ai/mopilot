// The Host's client of the computer-use helper (G8, #3903): launches the helper app in the logged-in session through LaunchServices and speaks its newline-delimited JSON-RPC over a private unix socket, as the app's own client does (electron/capabilities/computer.cjs, which the Host may not import: host/boundary.json). The two follow the helper's protocol (native/helper), not each other. Reads never replay a write: a request in flight when the helper exits fails with `helper_exited` and is not sent again, because it may already have happened.
import { spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { JsonReader } = require('../../electron/transport/jsonReader.cjs');

export class HelperError extends Error {
  /** @param {string} message @param {string | null} reason what the helper (or this client) says went wrong: `helper_exited`, `helper_unavailable`, `permission_denied`, ... @param {number | null} [code] */
  constructor(message, reason, code = null) {
    super(message);
    this.name = 'HelperError';
    this.reason = reason;
    this.code = code;
  }
}

/** Requests about the helper's own running state: a helper that is not running has nothing to undo, so none is launched for them. */
const NO_LAUNCH = new Set(['control.release', 'input.release', 'app.cancel']);

/**
 * @param {object} o
 * @param {string} o.appPath the helper app ("MoPilot Code.app") provisioned on this machine
 * @param {number} [o.mainPid] the process the helper ties itself to; it exits when this one does
 * @param {NodeJS.Platform} [o.platform]
 * @param {(p: string) => boolean} [o.exists]
 * @param {typeof nodeSpawn} [o.spawn]
 * @param {number} [o.connectTimeoutMs] @param {number} [o.callTimeoutMs]
 * @param {string} [o.tmp] where the private socket folder goes
 */
export function createHelperClient({
  appPath,
  mainPid = process.pid,
  platform = process.platform,
  exists = (p) => fs.existsSync(p),
  spawn = nodeSpawn,
  connectTimeoutMs = 15_000,
  callTimeoutMs = 30_000,
  tmp = os.tmpdir(),
}) {
  /** @type {net.Socket | null} */
  let socket = null;
  /** @type {Promise<net.Socket> | null} */
  let starting = null;
  /** @type {string | null} */
  let dir = null;
  let nextId = 1;
  /** how many helpers this client has started: a lease that took control on one is not holding it on the next */
  let generation = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();

  const forget = () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  };

  /** The socket went: everything waiting on it fails, and the next call starts the helper again. @param {net.Socket} sock */
  function lost(sock) {
    if (socket !== sock) return;
    socket = null;
    forget();
    for (const p of pending.values()) p.reject(new HelperError('The computer-use helper exited.', 'helper_exited'));
    pending.clear();
  }

  /** Its lines, framed by the Rust core (electron/transport/jsonReader.cjs); one that is not JSON is not an answer to anything. @param {net.Socket} sock */
  function attach(sock) {
    const reader = new JsonReader({
      stream: sock,
      onValue: (/** @type {any} */ msg) => {
        const p = msg && typeof msg === 'object' ? pending.get(msg.id) : undefined;
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error)
          p.reject(new HelperError(String(msg.error.message ?? 'helper error'), msg.error.data?.reason ?? null, msg.error.code ?? null));
        else p.resolve(msg.result);
      },
      onError: () => sock.destroy(),
    });
    sock.on('data', (/** @type {Buffer} */ chunk) => reader.push(chunk));
    sock.on('error', () => undefined);
    // what came before the close is answered first
    sock.on('close', () => reader.finishInput(() => lost(sock)));
  }

  /** @param {string} socketPath */
  async function connect(socketPath) {
    const deadline = Date.now() + connectTimeoutMs;
    for (;;) {
      try {
        return await new Promise((resolve, reject) => {
          const s = net.createConnection(socketPath);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
      } catch (e) {
        if (Date.now() > deadline)
          throw new HelperError(`The computer-use helper did not start: ${/** @type {Error} */ (e).message}`, 'helper_unavailable');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  /** @param {net.Socket} sock @param {string} method @param {object} params @param {number} timeoutMs */
  function send(sock, method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new HelperError(`The computer-use helper did not answer ${method}.`, 'helper_timeout'));
      }, timeoutMs);
      timer.unref?.();
      const settle = (/** @type {(v: any) => void} */ fn) => (/** @type {any} */ v) => {
        clearTimeout(timer);
        fn(v);
      };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Launches the helper and says hello; the connected socket. @returns {Promise<net.Socket>} */
  async function start() {
    if (platform !== 'darwin') throw new HelperError('Computer use needs macOS.', 'helper_unavailable');
    if (!exists(appPath)) throw new HelperError(`The computer-use helper is not at ${appPath}.`, 'helper_unavailable');
    dir = fs.mkdtempSync(path.join(tmp, 'mpcu-'));
    fs.chmodSync(dir, 0o700);
    const socketPath = path.join(dir, 'h.sock');
    const token = crypto.randomBytes(32).toString('hex');
    const config = path.join(dir, 'launch.json');
    fs.writeFileSync(config, JSON.stringify({ socket: socketPath, token, mainPid, denyBundleIds: [] }), { mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/open', ['-n', '-g', '-a', appPath, '--args', '--launch', config], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        // LaunchServices can wait for a session that never comes (no one logged in): the wait ends, and `open` with it
        const giveUp = setTimeout(() => {
          child.kill?.();
          reject(new Error(`open did not finish in ${connectTimeoutMs} ms`));
        }, connectTimeoutMs);
        giveUp.unref?.();
        child.stderr?.on('data', (d) => (err += d));
        child.on('error', (e) => (clearTimeout(giveUp), reject(e)));
        child.on('exit', (code) => {
          clearTimeout(giveUp);
          if (code === 0) resolve(undefined);
          else reject(new Error(`open failed (${code}): ${err.trim()}`));
        });
      });
      const sock = await connect(socketPath);
      socket = sock;
      attach(sock);
      await send(sock, 'hello', { token }, callTimeoutMs);
      generation += 1;
      return sock;
    } catch (e) {
      stop();
      throw e instanceof HelperError
        ? e
        : new HelperError(`The computer-use helper could not be started: ${/** @type {Error} */ (e).message}`, 'helper_unavailable');
    }
  }

  function stop() {
    const sock = socket;
    if (sock) {
      lost(sock);
      sock.destroy();
    } else forget();
  }

  return {
    /** Which helper this is: bumped each time one starts, so a holder can tell it is not the one it took control on. */
    get generation() {
      return generation;
    },
    /** Whether the helper is up now: false before the first call and after it exited (the next call starts it again). */
    get running() {
      return socket !== null && starting === null;
    },
    /** Whether there is a helper to launch here: macOS with the app in place. Starts nothing. */
    get installed() {
      return platform === 'darwin' && exists(appPath);
    },
    /**
     * One request, launching the helper first when it is not running (not for the requests that only undo).
     * @param {string} method @param {object} [params] @param {{ timeoutMs?: number }} [opts]
     */
    async call(method, params = {}, { timeoutMs = callTimeoutMs } = {}) {
      if (!socket && NO_LAUNCH.has(method) && !starting)
        throw new HelperError('The computer-use helper is not running.', 'helper_not_running');
      const sock = socket && !starting ? socket : await (starting ??= start().finally(() => void (starting = null)));
      return send(sock, method, params, timeoutMs);
    },
    stop,
  };
}
