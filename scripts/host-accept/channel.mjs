// How the acceptance run reaches a machine: one command with bytes on its standard input, and a duplex stream to a program on it (`nc -U` to the Host's socket). A Tart VM is reached through scripts/vm-exec.sh (`tart exec`, no ssh needed); any other machine through ssh.
import { spawn } from 'node:child_process';

/** What a command run by `tart exec` lacks of a login shell's PATH: Homebrew's Node. */
const PATH_PREFIX = 'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; ';
/** The most of a command's output that is kept. */
const KEEP = 256 * 1024;

/**
 * The program and arguments that run `command` in a Tart VM.
 * @param {string} vm @param {string} script scripts/vm-exec.sh
 * @returns {(command: string, stdin: boolean) => { bin: string, args: string[] }}
 */
export const vmLauncher = (vm, script) => (command, stdin) => ({
  bin: script,
  args: ['--vm', vm, ...(stdin ? ['--stdin'] : []), 'sh', '-c', `${PATH_PREFIX}${command}`],
});

/**
 * The program and arguments that run `command` on a machine over ssh (the remote shell parses the line).
 * @param {string} destination @param {string[]} [sshArgs] extra options such as `-p`, `-i` or `-J`
 * @returns {(command: string, stdin?: boolean) => { bin: string, args: string[] }}
 */
export const sshLauncher =
  (destination, sshArgs = []) =>
  (command) => ({ bin: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...sshArgs, '--', destination, command] });

/**
 * @param {object} o
 * @param {(command: string, stdin: boolean) => { bin: string, args: string[] }} o.launcher
 * @param {typeof spawn} [o.spawnFn] @param {number} [o.timeoutMs] how long one command may take
 */
export function createChannel({ launcher, spawnFn = spawn, timeoutMs = 180_000 }) {
  return {
    /**
     * Run a command to its end. Every outcome is a result: a failure to start or a timeout is code -1.
     * @param {string} command @param {Buffer} [input] written to the command's standard input @param {{ timeoutMs?: number }} [o] a command that takes longer than the channel's usual limit (a test run)
     * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
     */
    run(command, input, { timeoutMs: limit = timeoutMs } = {}) {
      const { bin, args } = launcher(command, input !== undefined);
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (/** @type {number} */ code, extra = '') => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ code, stdout, stderr: `${stderr}${extra}` });
        };
        const child = spawnFn(bin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => (child.kill('SIGTERM'), finish(-1, '\nTimed out.')), limit);
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(input);
        child.stdout?.on('data', (c) => (stdout = (stdout + c).slice(-KEEP)));
        child.stderr?.on('data', (c) => (stderr = (stderr + c).slice(-KEEP)));
        child.on('error', (e) => finish(-1, e.message));
        child.on('close', (code) => finish(code ?? -1));
      });
    },
    /**
     * Start a program on the machine and keep its standard input and output as a stream.
     * @param {string} command
     */
    open(command) {
      const { bin, args } = launcher(command, true);
      const child = spawnFn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
      child.stdin?.on('error', () => undefined);
      return {
        /** @param {string} text */
        write: (text) => child.stdin?.write(text),
        /** @param {(chunk: string) => void} fn */
        onData: (fn) => child.stdout?.on('data', (c) => fn(String(c))),
        kill: () => child.kill('SIGTERM'),
        closed: new Promise((resolve) => child.on('close', () => resolve(undefined))),
      };
    },
  };
}
