// A port on a remote machine, forwarded to this Mac's loopback so a dev server the agent started there can be opened in the Mac's own browser (design/host/index.html, package 2.6): the user's `ssh -N -L`, one per (machine, port), shared while it lives.
//
// Only loopback to loopback: this Mac listens on 127.0.0.1 and ssh connects to the machine's 127.0.0.1, whatever the page asked for.
const { sshTarget } = require('../../shared/host/sshDestination.mjs');
const net = require('node:net');
const { proc } = require('../platform/ports/proc.cjs');
const { clock } = require('../platform/ports/clock.cjs');

/** How much of ssh's stderr is kept to say why it ended. */
const STDERR_KEEP = 2000;

/** How long a forward lives after it was last asked for: a dev server's page keeps reaching it by being asked for again, and a port nobody uses closes (it is open to every process on this Mac, and to web pages that guess it). */
const IDLE_MS = 30 * 60_000;

/** How many local ports are tried when ssh finds the one it was given taken in the moment between choosing it and listening on it. */
const BIND_TRIES = 3;
/** What ssh says when it cannot listen on the local port (`bind [127.0.0.1]:41000: Address already in use`, `cannot listen to port`). */
const PORT_TAKEN = /address already in use|cannot listen to port/i;

/** A forward that could not be made: ssh ended, or nothing answered on the port in time. @param {string} message */
class ForwardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForwardError';
    this.code = 'forward_failed';
  }
}

/** A free port on this Mac's loopback. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });
}

/**
 * @param {object} o
 * @param {() => NodeJS.ProcessEnv} [o.env] the environment ssh runs in (the login shell's)
 * @param {string} [o.sshBin]
 * @param {() => Promise<number>} [o.pickPort] a free local port
 * @param {(port: number) => import('node:net').Socket} [o.connect] a try at the local port
 * @param {number} [o.probeMs] how often the local port is tried while ssh comes up
 * @param {number} [o.timeoutMs] how long ssh has to make the forward
 * @param {number} [o.idleMs] how long a forward stays up after it was last asked for
 * @param {number} [o.settleMs] how long a connection to the local port must stay open: ssh listens before it knows the machine's port answers, and closes the connection at once when it does not
 */
function createPortForwards({
  env = () => process.env,
  sshBin = 'ssh',
  pickPort = freePort,
  connect = (port) => net.connect(port, '127.0.0.1'),
  probeMs = 200,
  timeoutMs = 20_000,
  settleMs = 400,
  idleMs = IDLE_MS,
} = {}) {
  /** `${machine}\n${destination}\n${port}` -> the forward being made or up (a machine answering to a new address is a new forward). @type {Map<string, { machine: string, ready: Promise<{ localPort: number }>, stop: () => void, touch: () => void }>} */
  const forwards = new Map();

  /** @param {string} machine @param {string} destination @param {string[]} sshArgs @param {number} remotePort */
  function start(machine, destination, sshArgs, remotePort) {
    const key = `${machine}\n${destination}\n${remotePort}`;
    /** the ssh while it runs; null before it starts and after it ended @type {{ kill: (signal: 'SIGTERM') => unknown } | null} */
    let running = null;
    /** the machine left or the app closed: an ask still choosing its port must not start an ssh nobody tracks any more */
    let stopped = false;
    const killRunning = () => running?.kill('SIGTERM');
    /** @type {any} */
    let idle = null;
    const stop = () => {
      stopped = true;
      clock.clearTimeout(idle);
      killRunning();
    };
    /** A forward that is asked for again lives another `idleMs`; one that is not closes. */
    const touch = () => {
      clock.clearTimeout(idle);
      idle = clock.setTimeout(() => {
        if (forwards.get(key) === entry) forwards.delete(key);
        stop();
      }, idleMs);
    };
    const attempt = async () => {
      const localPort = await pickPort();
      if (stopped) throw new ForwardError('The machine is gone.');
      let stderr = '';
      const child = proc.spawn(
        sshBin,
        [
          '-N',
          // no prompt can be answered here, and a forward that cannot be made is a failure, not a quiet one
          '-o',
          'BatchMode=yes',
          '-o',
          'ExitOnForwardFailure=yes',
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
          `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          ...sshTarget(destination).args,
          ...sshArgs,
          // `--`: a destination that starts with a dash is a host name, never an ssh option
          '--',
          sshTarget(destination).target,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], env: env() },
      );
      running = child;
      child.stderr?.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-STDERR_KEEP);
      });
      // both ways a forward can fail are values, not rejections: nothing is left unhandled and nothing is swallowed
      /** @type {(e: ForwardError) => void} */
      let fail;
      const exited = new Promise((resolve) => {
        fail = resolve;
      });
      child.once('error', (e) => fail(new ForwardError(e.message)));
      let isUp = false;
      let over = false;
      child.once('exit', (code, signal) => {
        running = null;
        // before it was up the ask's own failure removes the forward (a retry keeps it)
        if (isUp && forwards.get(key) === entry) forwards.delete(key);
        fail(new ForwardError(stderr.trim() || `ssh ended (${signal ?? code}).`));
      });
      /** @type {Promise<ForwardError | null>} */
      const up = new Promise((resolve) => {
        const deadline = clock.now() + timeoutMs;
        const probe = () => {
          if (over) return;
          const socket = connect(localPort);
          let connected = false;
          socket.once('connect', () => {
            connected = true;
            const stays = clock.setTimeout(() => (socket.destroy(), resolve(null)), settleMs);
            socket.once('close', () => {
              clock.clearTimeout(stays);
              resolve(new ForwardError(`Nothing is listening on port ${remotePort} of the machine.`));
            });
          });
          socket.once('error', () => {
            // after the connect, the close that follows says what happened
            if (connected) return;
            socket.destroy();
            if (clock.now() >= deadline) resolve(new ForwardError('The machine did not answer in time.'));
            else clock.setTimeout(probe, probeMs);
          });
        };
        probe();
      });
      const failure = await Promise.race([up, exited]);
      over = true;
      if (failure) {
        killRunning();
        throw failure;
      }
      isUp = true;
      return { localPort };
    };
    /** @param {number} tries @returns {Promise<{ localPort: number }>} */
    const bind = async (tries) => {
      try {
        return await attempt();
      } catch (e) {
        // only a local port taken in the meantime is worth another port; anything else (or a machine that left) is the answer
        if (tries >= BIND_TRIES || stopped || !PORT_TAKEN.test(/** @type {Error} */ (e).message)) throw e;
        return bind(tries + 1);
      }
    };
    const ready = bind(1);
    const entry = { machine, ready, stop, touch };
    forwards.set(key, entry);
    touch();
    // a forward that failed is not kept: the next ask makes a new one
    ready.catch(() => {
      clock.clearTimeout(idle);
      if (forwards.get(key) === entry) forwards.delete(key);
    });
    return entry;
  }

  return {
    /**
     * This Mac's loopback port that reaches `remotePort` on the machine; a second ask for the same port shares the forward.
     * @param {{ machine: string, destination: string, sshArgs?: string[], remotePort: number }} t
     * @returns {Promise<{ localPort: number }>}
     */
    forward({ machine, destination, sshArgs = [], remotePort }) {
      const known = forwards.get(`${machine}\n${destination}\n${remotePort}`);
      known?.touch();
      return (known ?? start(machine, destination, sshArgs, remotePort)).ready;
    },
    /** A machine left or its connection ended: its forwards go. @param {string} machine */
    closeMachine(machine) {
      for (const [key, f] of [...forwards]) {
        if (f.machine !== machine) continue;
        forwards.delete(key);
        f.stop();
      }
    },
    /** Every forward goes (access was lost, or the app closes). */
    dispose() {
      for (const f of forwards.values()) f.stop();
      forwards.clear();
    },
  };
}

module.exports = { createPortForwards, ForwardError };
