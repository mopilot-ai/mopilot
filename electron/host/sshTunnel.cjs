// The SSH tunnel to a remote Host: the user's `ssh` forwards a local unix socket to the Host's unix socket (the Host never listens on TCP); one tunnel per Host is shared by every window, and it reconnects with backoff.
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { proc } = require('../platform/ports/proc.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const frames = require('../../shared/host/frames.mjs');
const { hostAccess, onHostAccess } = require('./access.cjs');
const { sshTarget } = require('../../shared/host/sshDestination.mjs');

/** @typedef {'online' | 'connecting' | 'offline'} TunnelState */

/** A unix socket path must fit `sun_path` (104 bytes on macOS, 108 on Linux), terminator included. */
const MAX_SOCKET_PATH = 100;

/** Doubling from 1 s to a 10 s cap: a machine that comes back (the network returns) is reached within ten seconds, where a 30 s cap made it wait up to half a minute for the next attempt (Remote Run #5134). */
const BACKOFF = { baseMs: 1000, maxMs: 10_000 };
/** A tunnel that stayed online this long has earned a fresh backoff; one that fell over sooner keeps climbing. */
const STABLE_MS = 30_000;
/** How much of ssh's stderr is kept to say why it ended. */
const STDERR_KEEP = 2000;

/** The wait before reconnect attempt number `attempt` (0 first): doubling, capped. @param {number} attempt @param {{ baseMs: number, maxMs: number }} backoff */
function backoffDelay(attempt, { baseMs, maxMs }) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
}

/**
 * One tunnel to one Host. It starts when the first lease is taken and stops when the last one is released.
 * @param {object} o
 * @param {string} o.destination what `ssh` connects to: `host`, `user@host` or a Host alias from ssh_config
 * @param {string} o.remoteSocket the Host's unix socket path on the remote machine
 * @param {string} o.localSocket where the forwarded socket appears on this machine
 * @param {string} [o.sshBin]
 * @param {string[]} [o.sshArgs] extra ssh options, such as `-p`, `-i` or `-J`
 * @param {{ baseMs: number, maxMs: number }} [o.backoff]
 * @param {number} [o.stableMs] how long online earns the backoff a fresh start
 * @param {number} [o.probeMs] how often the local socket is tried while ssh comes up
 * @param {number} [o.connectTimeoutMs] how long one attempt may take to reach a Host that answers
 * @param {number} [o.helloMs] how long one probe waits for the Host's answer
 * @param {(socketPath: string) => import('node:net').Socket} [o.connect]
 * @param {() => NodeJS.ProcessEnv} [o.env] the environment ssh runs in; the app passes its login-shell one (electron/platform/env.cjs)
 */
function createTunnel({
  destination,
  remoteSocket,
  localSocket,
  sshBin = 'ssh',
  sshArgs = [],
  backoff = BACKOFF,
  stableMs = STABLE_MS,
  probeMs = 200,
  connectTimeoutMs = 20_000,
  helloMs = 5000,
  connect = (p) => net.connect(p),
  env = () => process.env,
}) {
  /** @type {TunnelState} */
  let state = 'offline';
  let reason = '';
  let refs = 0;
  let attempt = 0;
  /** When the tunnel last came online, until it goes down. @type {number | null} */
  let onlineAt = null;
  /** Bumped whenever an attempt ends, so a late exit, probe or timer from an earlier attempt does nothing. */
  let generation = 0;
  /** @type {ReturnType<typeof proc.spawn> | null} */
  let child = null;
  /** @type {any} */
  let timer = null;
  /** @type {Set<(ok: boolean) => void>} */
  const waiting = new Set();
  /** @type {Set<(state: TunnelState, reason: string) => void>} */
  const listeners = new Set();

  /** @param {TunnelState} next @param {string} [why] */
  const setState = (next, why = '') => {
    state = next;
    reason = why;
    for (const fn of [...listeners]) fn(next, why);
  };
  const clearTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const killChild = () => {
    const c = child;
    child = null;
    c?.kill('SIGTERM');
  };

  /** This attempt is over: stop ssh, and wait out the backoff before the next one while someone still holds the tunnel. @param {string} why */
  function down(why) {
    generation++;
    clearTimer();
    killChild();
    if (onlineAt !== null && clock.now() - onlineAt >= stableMs) attempt = 0;
    onlineAt = null;
    setState('offline', why);
    const delay = backoffDelay(attempt++, backoff);
    timer = clock.setTimeout(launch, delay);
  }

  function online() {
    clearTimer();
    onlineAt = clock.now();
    setState('online');
    for (const settle of [...waiting]) settle(true);
  }

  /** @param {number} gen @param {number} deadline */
  function probe(gen, deadline) {
    const retry = () => {
      if (clock.now() >= deadline) return down('The host did not answer in time.');
      timer = clock.setTimeout(() => probe(gen, deadline), probeMs);
    };
    const socket = connect(localSocket);
    const decoder = frames.createDecoder();
    let done = false;
    /** @param {boolean} ok */
    const finish = (ok) => {
      if (done) return;
      done = true;
      clock.clearTimeout(guard);
      socket.destroy();
      if (gen !== generation) return;
      if (ok) online();
      else retry();
    };
    // a socket that stays open and answers nothing (ssh accepted the connection, the Host did not reply) counts as no answer
    const guard = clock.setTimeout(() => finish(false), helloMs);
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    socket.once('connect', () => socket.write(frames.encodeControl({ id: 0, method: 'ping' })));
    socket.on('data', (chunk) => {
      try {
        if (decoder.push(chunk).some((f) => f.kind === 'control' && f.message.result === 'pong')) finish(true);
      } catch {
        finish(false);
      }
    });
  }

  function launch() {
    timer = null;
    const gen = ++generation;
    setState('connecting');
    let stderr = '';
    try {
      fs.mkdirSync(path.dirname(localSocket), { recursive: true, mode: 0o700 });
      // the forwarded socket is as open as its folder: an existing one is narrowed too
      fs.chmodSync(path.dirname(localSocket), 0o700);
      fs.rmSync(localSocket, { force: true });
      child = proc.spawn(
        sshBin,
        [
          '-N',
          // no prompt can be answered here, and a forward that cannot be made is a failed tunnel, not a quiet one
          '-o',
          'BatchMode=yes',
          '-o',
          'ExitOnForwardFailure=yes',
          '-o',
          'StreamLocalBindUnlink=yes',
          // the machine is not trusted with this Mac's ssh agent or display, whatever the user's ssh config says (the first value given wins)
          '-o',
          'ForwardAgent=no',
          '-o',
          'ForwardX11=no',
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=2',
          '-L',
          `${localSocket}:${remoteSocket}`,
          ...sshTarget(destination).args,
          ...sshArgs,
          // `--`: a destination that starts with a dash is a host name, never an ssh option
          '--',
          sshTarget(destination).target,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], env: env() },
      );
    } catch (e) {
      return down(/** @type {Error} */ (e).message);
    }
    const mine = child;
    mine.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    mine.once('error', (e) => gen === generation && down(e.message));
    mine.once('exit', (code, signal) => gen === generation && down(stderr.trim() || `ssh ended (${signal ?? code}).`));
    probe(gen, clock.now() + connectTimeoutMs);
  }

  function stop() {
    generation++;
    attempt = 0;
    onlineAt = null;
    clearTimer();
    killChild();
    fs.rmSync(localSocket, { force: true });
    setState('offline');
  }

  return {
    localSocket,
    /** online, connecting (ssh starting, or the Host not answering yet) or offline (stopped, or waiting to retry) */
    get state() {
      return state;
    },
    /** Why the last attempt ended; empty while online. */
    get reason() {
      return reason;
    },
    /** Calls `fn(state, reason)` on every change; returns the function that stops it. @param {(state: TunnelState, reason: string) => void} fn */
    onState(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /**
     * Takes a share of the tunnel and starts it when it was idle. `ready` resolves true when the Host answers, and false
     * when the lease is released first. The tunnel runs while any lease is held.
     */
    acquire() {
      refs++;
      let released = false;
      let settle = /** @type {(ok: boolean) => void} */ (/** @type {any} */ (null));
      const ready = new Promise((resolve) => {
        settle = (ok) => (waiting.delete(settle), resolve(ok));
      });
      if (state === 'online') settle(true);
      else waiting.add(settle);
      if (refs === 1) launch();
      return {
        socketPath: localSocket,
        ready,
        release() {
          if (released) return;
          released = true;
          settle(false);
          if (--refs === 0) stop();
        },
      };
    },
    /** The connection through the tunnel is broken (a bad frame, silence): take the tunnel down so it reconnects. @param {string} why */
    fail(why) {
      if (state !== 'offline') down(why);
    },
    /** Stop ssh now whoever still holds a lease (Host access was lost): waiting leases settle false, and the holders' releases then do nothing more. */
    close() {
      refs = 0;
      for (const settle of [...waiting]) settle(false);
      stop();
    },
    /** How many leases are held. */
    get leases() {
      return refs;
    },
  };
}

/**
 * Where a tunnel folder's sockets go: the folder itself, or, when its path is too long for a socket (a long user name, a deep
 * profile), a short owner-only folder of the temp dir named by it so two profiles do not share one. The relay tunnels use it too.
 * @param {string} dir
 */
function socketDirFor(dir) {
  return path.join(dir, 'x'.repeat(21)).length <= MAX_SOCKET_PATH
    ? dir
    : path.join(os.tmpdir(), `mopilot-host-${os.userInfo().uid}-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 6)}`);
}

/**
 * The ssh options of a tunnel: the target's own, then the pool's defaults. A target that brings none (a machine on the default key) keeps the pool's;
 * one that brings a key adds it. An option the target already gave (the same flag and value) is not repeated; ssh uses the first value given for an `-o`, so the target's wins.
 * @param {string[] | undefined} defaults @param {string[] | undefined} own
 */
function mergeSshArgs(defaults, own) {
  const out = [];
  const seen = new Set();
  const withValue = new Set(['-i', '-o', '-p', '-J', '-l', '-F']);
  // Target single-value options replace defaults: repeated -J is rejected and -F takes the last value. Keys and -o options remain additive.
  const single = new Set(['-p', '-J', '-l', '-F']);
  /** @param {string[]} list */
  const pairsOf = (list) => {
    /** @type {string[][]} */
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      pairs.push(withValue.has(list[i]) && i + 1 < list.length ? [list[i], list[++i]] : [list[i]]);
    }
    return pairs;
  };
  /** @param {string[]} pair */
  const flagOf = (pair) => (/^-[pJlF]./.test(pair[0]) ? pair[0].slice(0, 2) : pair[0]);
  const ownPairs = pairsOf(own ?? []);
  const ownSingles = new Set(ownPairs.map(flagOf).filter((f) => single.has(f)));
  for (const [pairs, isDefault] of /** @type {const} */ ([
    [ownPairs, false],
    [pairsOf(defaults ?? []), true],
  ])) {
    for (const pair of pairs) {
      if (isDefault && ownSingles.has(flagOf(pair))) continue;
      const k = JSON.stringify(pair);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(...pair);
    }
  }
  return out;
}

/**
 * The tunnels of this app, one per Host: asking twice for the same Host gives the same tunnel, which every window shares.
 * @param {{ dir: string, allowed?: () => boolean, watch?: (cb: (ok: boolean) => void) => unknown } & Partial<Parameters<typeof createTunnel>[0]>} o `dir` holds the forwarded sockets (owner-only); `allowed` is Host's closed-alpha gate and `watch` follows it (both default to electron/host/access.cjs), without which no tunnel (so no ssh, remote Host or heartbeat) is made
 */
function createTunnelPool({ dir, allowed = hostAccess, watch = onHostAccess, ...defaults }) {
  /** @type {Map<string, ReturnType<typeof createTunnel>>} */
  const tunnels = new Map();
  const closeAll = () => {
    for (const t of tunnels.values()) t.close();
    tunnels.clear();
  };
  // losing access (a revoke, the kill switch, sign-out) takes down every tunnel that is up, so no ssh or heartbeat outlives Host access
  watch((ok) => {
    if (!ok) closeAll();
  });
  const socketDir = socketDirFor(dir);
  return {
    /** Stops ssh for every Host whoever still holds a lease (the app is quitting): a heartbeat's lease would otherwise keep its ssh running after the app. */
    closeAll,
    /** @param {{ destination: string, remoteSocket: string, sshArgs?: string[] }} target */
    get(target) {
      if (!allowed()) throw new Error('Host is not available for this account.');
      const key = `${target.destination}\n${target.remoteSocket}\n${(target.sshArgs ?? []).join(' ')}`;
      let tunnel = tunnels.get(key);
      if (!tunnel) {
        // a unix socket path is short (about 100 bytes), so the file is named by a hash of the Host
        const name = `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}.sock`;
        const localSocket = path.join(socketDir, name);
        tunnel = createTunnel({ ...defaults, ...target, sshArgs: mergeSshArgs(defaults.sshArgs, target.sshArgs), localSocket });
        tunnels.set(key, tunnel);
      }
      return tunnel;
    },
  };
}

module.exports = { createTunnel, createTunnelPool, mergeSshArgs, backoffDelay, socketDirFor, BACKOFF };
