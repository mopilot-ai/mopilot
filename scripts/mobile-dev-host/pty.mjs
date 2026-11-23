// DEV ONLY terminal for the phone's mirror: a real pty (node-pty) in the chat's folder, or plain pipes to a shell when node-pty cannot load on this machine.
import { spawn as spawnChild } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * node-pty's prebuilt spawn-helper loses its execute bit when packages are installed without running scripts, and then no shell
 * can start ("posix_spawnp failed"). Gives it the bit back.
 * @param {object} [o]
 * @param {string} [o.root] node-pty's folder (default: where it is installed)
 * @returns {string | null} the helper that was repaired, null when it was fine or is not there
 */
export function repairSpawnHelper({ root = path.dirname(require.resolve('node-pty/package.json')) } = {}) {
  const helper = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  try {
    if (statSync(helper).mode & 0o111) return null;
    chmodSync(helper, 0o755);
    return helper;
  } catch {
    return null;
  }
}

/**
 * @param {object} [o]
 * @param {() => any} [o.load] node-pty, injected by tests
 * @param {string} [o.shell]
 * @param {typeof spawnChild} [o.spawnChild]
 * @param {(why: string) => void} [o.onFallback] told when a shell runs on pipes because node-pty could not start it
 * @param {() => string | null} [o.repair] puts node-pty's spawn-helper right before the first shell
 * @param {(helper: string) => void} [o.onRepair] told which helper was repaired
 */
export function createPty({
  load = () => require('node-pty'),
  shell = process.env.SHELL || '/bin/zsh',
  spawnChild: spawnPipe = spawnChild,
  onFallback = () => undefined,
  repair = repairSpawnHelper,
  onRepair = () => undefined,
} = {}) {
  /** @type {Map<string, { write: (d: string) => void, resize: (c: number, r: number) => void, kill: () => void, pause: () => void, resume: () => void, killed: boolean }>} */
  const live = new Map();
  /** @type {any} */
  let nodePty = null;
  try {
    nodePty = load();
  } catch {
    nodePty = null;
  }
  if (nodePty) {
    const helper = repair();
    if (helper) onRepair(helper);
  }

  return {
    /** Whether node-pty loaded (a shell it cannot start still runs on pipes). */
    get real() {
      return nodePty !== null;
    },
    spawn(/** @type {string} */ key, /** @type {{ cwd: string, cols: number, rows: number }} */ { cwd, cols, rows }, /** @type {any} */ h) {
      /** @type {any} */
      let entry;
      const exit = (/** @type {number | null} */ exitCode, /** @type {unknown} */ signal) => {
        // a shell that ended on its own is not there for a later kill
        if (live.get(key) === entry) live.delete(key);
        h.onExit({ exitCode, signal, killed: entry.killed });
      };
      /** @type {any} */
      let proc = null;
      try {
        proc = nodePty?.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env: process.env }) ?? null;
      } catch (error) {
        // typically the spawn-helper lost its execute bit (an install that skipped scripts)
        onFallback(String(/** @type {any} */ (error)?.message ?? error));
      }
      if (proc) {
        proc.onData(h.onData);
        proc.onExit((/** @type {{ exitCode: number, signal: unknown }} */ { exitCode, signal }) => exit(exitCode, signal));
        entry = {
          write: (/** @type {string} */ d) => proc.write(d),
          resize: (/** @type {number} */ c, /** @type {number} */ r) => proc.resize(c, r),
          kill: () => proc.kill(),
          pause: () => proc.pause(),
          resume: () => proc.resume(),
          killed: false,
        };
      } else {
        const child = spawnPipe(shell, ['-i'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout?.on('data', (d) => h.onData(String(d)));
        child.stderr?.on('data', (d) => h.onData(String(d)));
        child.on('exit', (code, signal) => exit(code, signal));
        // a shell that cannot start (no such program) ends the terminal instead of crashing the host
        child.on('error', () => exit(null, null));
        entry = {
          // no terminal turns the Return key's carriage return into a newline, so a line would never run
          write: (/** @type {string} */ d) => child.stdin?.write(d.replace(/\r/g, '\n')),
          resize: () => undefined,
          kill: () => child.kill('SIGKILL'),
          pause: () => child.stdout?.pause(),
          resume: () => child.stdout?.resume(),
          killed: false,
        };
      }
      live.set(key, entry);
    },
    write: (/** @type {string} */ key, /** @type {string} */ d) => live.get(key)?.write(d),
    resize: (/** @type {string} */ key, /** @type {number} */ c, /** @type {number} */ r) => live.get(key)?.resize(c, r),
    kill(/** @type {string} */ key) {
      const entry = live.get(key);
      if (!entry) return;
      entry.killed = true;
      live.delete(key);
      entry.kill();
    },
    pause: (/** @type {string} */ key) => live.get(key)?.pause(),
    resume: (/** @type {string} */ key) => live.get(key)?.resume(),
    /** Ends every shell (the host is stopping). */
    killAll() {
      for (const key of [...live.keys()]) this.kill(key);
    },
  };
}
