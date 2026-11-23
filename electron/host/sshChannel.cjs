// One command on a machine through the user's `ssh`, its output kept and every outcome a result. Without an askpass it never prompts (BatchMode); with one, the first command opens a shared connection (ControlMaster) whose questions (host key, password) are asked in the app, and the commands after it reuse that connection.
const crypto = require('node:crypto');
const path = require('node:path');
const { proc } = require('../platform/ports/proc.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const started = require('./started.cjs');
const { sshTarget } = require('../../shared/host/sshDestination.mjs');

const OUTPUT_KEEP = 64 * 1024;
/** Bytes written to a command's standard input at a time when its progress is wanted. */
const CHUNK = 256 * 1024;

/** Writes `input` to a command's standard input and ends it; with `onBytes`, in chunks that report how much the pipe took. @param {any} stdin @param {Buffer | undefined} input @param {((done: number, total: number) => void) | undefined} onBytes */
function feed(stdin, input, onBytes) {
  if (!input || !onBytes) return void stdin.end(input);
  let off = 0;
  const next = () => {
    if (off >= input.length) return void stdin.end();
    const part = input.subarray(off, off + CHUNK);
    off += part.length;
    stdin.write(part, (/** @type {Error | null | undefined} */ err) => {
      if (err) return;
      onBytes(off, input.length);
      next();
    });
  };
  next();
}
/** What a command run on a machine is never allowed to do with this Mac, whatever the user's ssh config says (the first value given wins): hand it the ssh agent or display, or forward anything. */
const SSH_SAFE = ['-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes'];

/** Where the shared connection to `destination` lives: a hash keeps the name short whatever the destination is. @param {string} dir @param {string} destination */
const controlPath = (dir, destination) =>
  path.join(dir, `cm-${crypto.createHash('sha256').update(destination).digest('hex').slice(0, 10)}`);
/** A unix socket path holds 103 bytes on macOS, and ssh first binds the master's socket under a name 17 characters longer. */
const MAX_CONTROL_PATH = 103 - 17;

/**
 * Runs one command on a machine through the user's `ssh`; every outcome is a result: a failure to start or a timeout is code -1.
 * @param {object} [o]
 * @param {string} [o.sshBin]
 * @param {string[]} [o.sshArgs] extra ssh options such as `-p`, `-i` or `-J`
 * @param {() => NodeJS.ProcessEnv} [o.env] the app's login-shell environment (electron/platform/env.cjs)
 * @param {number} [o.timeoutMs] how long a command may take, not counting the time a person spends answering a question
 * @param {{ env: (context: import('./sshAskpass.cjs').AskContext) => Promise<{ env: Record<string, string>, release: () => void }> } | null} [o.askpass] lets ssh ask in the app (sshAskpass.cjs); without it ssh never prompts
 * @param {string} [o.controlDir] where the shared connections live, with an askpass (short enough for a unix socket path)
 * @param {(destination: string) => string[]} [o.argsFor] ssh options a machine needs (the key it signs in with, sshKey.cjs identityArgs)
 * @returns {(destination: string, command: string, input?: Buffer, control?: { signal?: AbortSignal, onBytes?: (done: number, total: number) => void }) => Promise<{ code: number, stdout: string, stderr: string }>} `input` is written to the command's standard input; `control.onBytes` hears how much of it went, and `control.signal` ends the command (code -1, "Cancelled.")
 */
function createSshChannel({
  sshBin = 'ssh',
  sshArgs = [],
  env = () => process.env,
  timeoutMs = 120_000,
  askpass = null,
  controlDir = '',
  argsFor = () => [],
} = {}) {
  return async (destination, command, input, control = {}) => {
    if (control.signal?.aborted) return { code: -1, stdout: '', stderr: 'Cancelled.' };
    /** @type {any} */
    let timer = null;
    /** What a timeout does once ssh runs (the clock is first armed after that). @type {() => void} */
    let onTimeout;
    const arm = () => {
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => onTimeout(), timeoutMs);
    };
    /** @type {{ env: Record<string, string>, release: () => void } | null} */
    let asking = null;
    /** @type {import('./sshAskpass.cjs').AskContext} */
    const context = { destination, pause: () => clock.clearTimeout(timer), resume: arm };
    if (askpass) {
      try {
        asking = await askpass.env(context);
      } catch (e) {
        return { code: -1, stdout: '', stderr: `MoPilot could not set up its ssh prompt: ${/** @type {Error} */ (e).message}` };
      }
    }
    // a cancel that came while the askpass was being made
    if (control.signal?.aborted) {
      asking?.release();
      return { code: -1, stdout: '', stderr: 'Cancelled.' };
    }
    // with an askpass: ssh may ask, a first-seen host key is always shown (never accepted silently), and one connection serves every command
    const shared = controlPath(controlDir, destination);
    // a folder too deep for the socket: ssh still asks in the app, once per command instead of once per machine
    const sharing =
      shared.length <= MAX_CONTROL_PATH ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${shared}`, '-o', 'ControlPersist=60'] : [];
    // `user@host:2222` is ssh's `-p 2222` and `user@host`
    const { target, args: portArgs } = sshTarget(destination);
    const mode = asking ? ['-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask', ...sharing] : ['-o', 'BatchMode=yes'];
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      /** What an abort does once ssh runs. @type {(() => void) | null} */
      let onAbort = null;
      /** @param {number} code @param {string} [extra] */
      const finish = (code, extra = '') => {
        if (done) return;
        done = true;
        if (onAbort) control.signal?.removeEventListener('abort', onAbort);
        clock.clearTimeout(timer);
        asking?.release();
        resolve({ code, stdout, stderr: extra ? `${stderr}${stderr ? '\n' : ''}${extra}` : stderr });
      };
      /** @param {string} so @param {Buffer} chunk */
      const keep = (so, chunk) => (so + chunk.toString('utf8')).slice(-OUTPUT_KEEP);
      let child;
      try {
        // an install step still running when the app quits is stopped with it (electron/host/started.cjs)
        child = started.track(
          proc.spawn(
            sshBin,
            [...SSH_SAFE, ...mode, '-o', 'ConnectTimeout=15', ...portArgs, ...sshArgs, ...argsFor(destination), '--', target, command],
            {
              stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
              env: asking ? { ...env(), ...asking.env } : env(),
            },
          ),
        );
      } catch (e) {
        return finish(-1, /** @type {Error} */ (e).message);
      }
      // only this ssh and what it starts (its askpass) may ask
      context.pid = child.pid;
      // a command that ends before reading it all closes the pipe; its exit code says why
      child.stdin?.on('error', () => undefined);
      if (child.stdin) feed(child.stdin, input, control.onBytes);
      child.stdout.on('data', (/** @type {Buffer} */ c) => {
        stdout = keep(stdout, c);
      });
      child.stderr.on('data', (/** @type {Buffer} */ c) => {
        stderr = keep(stderr, c);
      });
      child.on('error', (/** @type {Error} */ e) => finish(-1, e.message));
      child.on('close', (/** @type {number | null} */ code) => finish(code ?? -1));
      onAbort = () => {
        child.kill('SIGTERM');
        finish(-1, 'Cancelled.');
      };
      control.signal?.addEventListener('abort', onAbort, { once: true });
      onTimeout = () => {
        child.kill('SIGTERM');
        finish(-1, 'Timed out.');
      };
      arm();
    });
  };
}

/**
 * Whether a machine signs in without a prompt, on a connection of its own (never a shared one), with `args` added: code 0 when it does.
 * @param {{ sshBin?: string, env?: () => NodeJS.ProcessEnv }} [o]
 * @returns {(destination: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
function createSshProbe({ sshBin = 'ssh', env = () => process.env } = {}) {
  return (destination, args) =>
    createSshChannel({ sshBin, env, timeoutMs: 30_000, sshArgs: ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...args] })(
      destination,
      'true',
    );
}

module.exports = { createSshChannel, createSshProbe, SSH_SAFE };
