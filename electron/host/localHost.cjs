// The background Host on this Mac (H1, behind host.local): the same Host package, installed by the same steps as for a remote machine but run on this Mac by a local command channel, reached on its unix socket directly (no ssh), added, updated and removed like any machine.
const os = require('node:os');
const { proc } = require('../platform/ports/proc.cjs');
const { noteIgnored } = require('../ignored.cjs');
const started = require('./started.cjs');
const { createKeepsRunning } = require('./keepsRunning.cjs');

/** The machine's id in the registry: one per macOS user, since each user's app has its own registry and Host. */
const { LOCAL_HOST_ID: LOCAL_ID } = require('../../shared/host/localMachine.mjs');
/** The name every surface shows. */
const LOCAL_NAME = 'This Mac · keeps running';
/** The chip's second line: what a closed app cannot do for a chat there. */
const LOCAL_NOTE = 'Browser tools need the app open';
/** Install steps and commands run this long before they are given up. */
const COMMAND_MS = 120_000;
const OUTPUT_KEEP = 64 * 1024;

/** The address a local machine has in the registry: `local:<macOS user>`. @param {string} [user] */
const localAddress = (user = os.userInfo().username) => `local:${user}`;
/** Why Remove left this Mac's Host running, by what the uninstall answered. */
const LEFT = {
  daemon: 'Keep running is on, so the Host was left running. Turn it off first.',
  unsure: 'Couldn’t tell whether the Host starts at boot, so it was left running.',
  shared: 'Another machine in the list is, or may be, this Host, so it was left running.',
};

/** @param {unknown} address */
const isLocal = (address) => typeof address === 'string' && address.startsWith('local:');

/**
 * One command on this Mac as the signed-in user: the shape of an ssh channel (electron/host/sshChannel.cjs), so every install, update and remove step runs unchanged. Every outcome is a result.
 * @param {object} [o]
 * @param {() => NodeJS.ProcessEnv} [o.env] the app's login-shell environment
 * @param {number} [o.timeoutMs]
 * @returns {(destination: string, command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
function createLocalChannel({ env = () => process.env, timeoutMs = COMMAND_MS } = {}) {
  return (_destination, command, input) =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      /** @type {any} */
      let timer = null;
      /** @param {number} code @param {string} [extra] */
      const finish = (code, extra = '') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout,
          stderr: extra ? `${stderr}${stderr ? '\n' : ''}${extra}` : stderr,
        });
      };
      /** @param {string} so @param {Buffer} chunk */
      const keep = (so, chunk) => (so + chunk.toString('utf8')).slice(-OUTPUT_KEEP);
      let child;
      try {
        // a step still running when the app quits is stopped with it; the Host it started is not (launchd owns that)
        child = started.track(
          proc.spawn('/bin/sh', ['-c', command], {
            stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            env: env(),
          }),
        );
      } catch (e) {
        return finish(-1, /** @type {Error} */ (e).message);
      }
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
      child.stdout.on('data', (/** @type {Buffer} */ c) => {
        stdout = keep(stdout, c);
      });
      child.stderr.on('data', (/** @type {Buffer} */ c) => {
        stderr = keep(stderr, c);
      });
      child.on('error', (/** @type {Error} */ e) => finish(-1, e.message));
      child.on('close', (/** @type {number | null} */ code) => finish(code ?? -1));
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(-1, 'Timed out.');
      }, timeoutMs);
    });
}

/** @typedef {(destination: string, command: string, input?: Buffer, control?: { signal?: AbortSignal, onBytes?: (done: number, total: number) => void }) => Promise<{ code: number, stdout: string, stderr: string }>} Channel */

/** A channel that sends a local address to this Mac and any other to `remote`; the `control` of a command (its abort and its upload's bytes, which an add's Cancel and progress ride on) goes with it. @param {Channel} remote @param {Channel} local @returns {Channel} */
const routeChannel = (remote, local) => (destination, command, input, control) =>
  (isLocal(destination) ? local : remote)(destination, command, input, control);

/** The tunnel of a local machine: the Host's own socket, always online, with the shape every tunnel has (pathTunnel.cjs Tunnel). @param {string} socket */
const localTunnel = (socket) => ({
  localSocket: socket,
  state: /** @type {const} */ ('online'),
  reason: '',
  onState: () => () => undefined,
  acquire: () => ({ socketPath: socket, ready: Promise.resolve(true), release: () => undefined }),
  fail: () => undefined,
  latencyMs: null,
});

/**
 * A tunnel pool that reaches a local machine's socket directly and hands every other target to `pool`.
 * @template {{ get: (target: any) => any, closeAll?: () => void }} P
 * @param {P} pool
 * @returns {P}
 */
function localPool(pool) {
  return /** @type {P} */ (
    /** @type {unknown} */ ({
      ...pool,
      get: (/** @type {{ destination: string, remoteSocket: string }} */ target) =>
        isLocal(target.destination) ? localTunnel(target.remoteSocket) : pool.get(target),
      closeAll: () => pool.closeAll?.(),
    })
  );
}

/** A refusal the window shows as it is. @param {string} code @param {string} message */
const refuse = (code, message) => Object.assign(new Error(message), { code });

/**
 * The app's handle on its own background Host: add (install, start, pair), keep it on the app's build, remove.
 * @param {object} o
 * @param {{ add: (destination: string, opts?: object) => Promise<{ ok: boolean, paired: boolean, error: string, id: string, steps: any[] }>, updateHost: (id: string) => Promise<unknown>, uninstallHost: (id: string, password: string) => Promise<{ left: string }>, remove: (id: string) => void, list: () => { machines: any[] }, onRowChange: (fn: () => void) => () => void }} o.machines
 * @param {() => boolean} o.enabled the host.local flag
 * @param {(error: unknown) => void} [o.report] where a failed background update is noted
 */
function createLocalHost({ machines, enabled, report = () => undefined }) {
  const guard = () => {
    if (!enabled()) throw refuse('off', 'The background Host is not available.');
  };
  const row = () => machines.list().machines.find((m) => m.id === LOCAL_ID);
  let updating = false;
  /** Brings the Host onto this app's build when it is behind; the Host restarts into it once no turn runs (its update waits for idle). */
  const sync = () => {
    const r = row();
    if (updating || !enabled() || !r || !r.hostStale || r.update === 'running') return;
    updating = true;
    machines
      .updateHost(LOCAL_ID)
      .catch(report)
      .finally(() => {
        updating = false;
      });
  };
  const off = machines.onRowChange(sync);
  return {
    /** Install and start the Host for this macOS user and pair with it, with no code shown. */
    add() {
      guard();
      return machines.add(localAddress());
    },
    /** Stop the service, delete its files and forget the machine; the machine stays listed when the files could not be deleted. */
    async remove() {
      guard();
      const out = await machines.uninstallHost(LOCAL_ID, '');
      // anything but a finished uninstall leaves the Host there: the machine stays listed and the cause is said
      if (out?.left) throw refuse('uninstall_incomplete', LEFT[/** @type {keyof typeof LEFT} */ (out.left)]);
      machines.remove(LOCAL_ID);
    },
    sync,
    dispose: off,
  };
}

/**
 * The two IPC calls of this Mac's background Host, its handle made when the first one comes (after the Host gate is open).
 * @param {object} o
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle
 * @param {() => Parameters<typeof createLocalHost>[0]['machines'] & { hostFor: (id: string) => { stop: (chatId: string) => Promise<unknown> } | null }} o.service
 * @param {() => boolean} o.enabled the host.local flag
 * @param {any} [o.deps] the app's wiring: `live.keepsRunning` is set for the quit sheet (keepsRunning.cjs)
 * @param {() => boolean} [o.allowed] Host's gate
 */
function registerLocalHost({ handle, service, enabled, deps, allowed = () => true }) {
  /** @type {ReturnType<typeof createLocalHost> | null} */
  let local = null;
  const host = () =>
    (local ??= createLocalHost({
      machines: service(),
      enabled,
      report: (error) => noteIgnored('update this Mac’s background Host', error),
    }));
  handle('host:addLocal', () => host().add());
  handle('host:removeLocal', () => host().remove());
  if (deps?.live) {
    // required here: machines.cjs requires this file
    const { hostOwnership } = require('./machines.cjs');
    const dir = deps.app.getPath('userData');
    const ownership = hostOwnership({ dir, allowed });
    deps.live.keepsRunning = createKeepsRunning({
      dir,
      runsHere: (chatId) => ownership.get(chatId).hostId === LOCAL_ID,
      stopChat: (chatId) => service().hostFor(LOCAL_ID)?.stop(chatId),
    });
  }
  return { dispose: () => local?.dispose() };
}

module.exports = {
  registerLocalHost,
  LOCAL_ID,
  LOCAL_NAME,
  LOCAL_NOTE,
  localAddress,
  isLocal,
  createLocalChannel,
  routeChannel,
  localPool,
  createLocalHost,
};
