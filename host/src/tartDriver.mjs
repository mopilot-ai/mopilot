// The real `tart` commands for the sandbox VM manager (host/src/sandboxVms.mjs, G8 #3903): clone, boot headless, suspend, delete, and which guests run now. Every command goes through one injected runner, so the manager's tests never start a VM and the commands a Mac runs are written down here once.
import { execFile, spawn } from 'node:child_process';
import { assertImageRef, assertVmName } from '../../shared/vmName.mjs';

/** How long a guest may take to show as running after `tart run`, and to get an address. */
const BOOT_MS = 120_000;
const POLL_MS = 1_000;

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} Ran
 * @typedef {(bin: string, args: string[], o?: { timeoutMs?: number }) => Promise<Ran>} Exec
 */

/** @type {Exec} */
const defaultExec = (bin, args, { timeoutMs = 600_000 } = {}) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (/** @type {any} */ (error).code) === 'number' ? /** @type {any} */ (error).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Starts `tart run` detached: the guest outlives this process's call and keeps no pipe to it. @type {(bin: string, args: string[]) => void} */
const defaultStart = (bin, args) => {
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
};

/**
 * @param {object} [o]
 * @param {string} [o.bin]
 * @param {Exec} [o.exec]
 * @param {(bin: string, args: string[]) => void} [o.start]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 */
export function createTartDriver({
  bin = 'tart',
  exec = defaultExec,
  start = defaultStart,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  /** @param {string[]} args @param {number} [timeoutMs] */
  const tart = async (args, timeoutMs) => {
    const r = await exec(bin, args, { timeoutMs });
    if (r.code !== 0) throw new Error(`tart ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}`);
    return r.stdout;
  };
  /** Every local guest `tart` knows, running or not. @returns {Promise<{ name: string, running: boolean }[]>} */
  async function list() {
    const rows = JSON.parse(await tart(['list', '--source', 'local', '--format', 'json']));
    if (!Array.isArray(rows)) throw new Error('tart list did not answer a list');
    const names = new Set();
    return rows.map((r) => {
      if (!r || typeof r.Name !== 'string' || !r.Name.trim() || names.has(r.Name)) throw new Error('Invalid tart inventory name');
      const hasFlag = Object.hasOwn(r, 'Running');
      const hasState = Object.hasOwn(r, 'State');
      if (
        (!hasFlag && !hasState) ||
        (hasFlag && typeof r.Running !== 'boolean') ||
        (hasState && !['running', 'stopped', 'suspended'].includes(r.State))
      )
        throw new Error('Invalid tart inventory state');
      if (hasFlag && hasState && r.Running !== (r.State === 'running')) throw new Error('Conflicting tart inventory state');
      names.add(r.Name);
      return { name: r.Name, running: hasFlag ? r.Running : r.State === 'running' };
    });
  }
  /** Waits until `ok` is true, or says what never happened. @param {() => Promise<boolean>} ok @param {string} what */
  async function until(ok, what) {
    const end = now() + BOOT_MS;
    for (;;) {
      if (await ok()) return;
      if (now() >= end) throw new Error(`${what} did not happen within ${BOOT_MS / 1000} s`);
      await sleep(POLL_MS);
    }
  }
  return {
    list,
    exists: async (/** @type {string} */ name) => (await list()).some((g) => g.name === name),
    /** Every guest that runs now, whoever started it: the Mac's two-guest limit counts all of them. */
    running: async () => (await list()).filter((g) => g.running).map((g) => g.name),
    /** A copy of `from` on the same disk (APFS clone): fast, and it shares nothing but the image's blocks. @param {string} from @param {string} name */
    clone: async (from, name) => {
      assertImageRef(from);
      assertVmName(name);
      await list();
      await tart(['clone', from, name]);
    },
    /** Boots the guest headless and returns when it is running and has an address (its Host starts with it). @param {string} name */
    async run(name) {
      assertVmName(name);
      await list();
      start(bin, ['run', '--no-graphics', '--no-audio', '--suspendable', '--no-clipboard', '--no-usb-accessories', '--net-softnet', name]);
      await until(async () => (await list()).some((g) => g.name === name && g.running), `The sandbox ${name} showing as running`);
      await tart(['ip', name, '--wait', '90'], 120_000);
    },
    /** Saves the guest's memory and stops it: it keeps its disk and resumes where it was. @param {string} name */
    suspend: async (name) => {
      assertVmName(name);
      await list();
      await tart(['suspend', name]);
    },
    /** Stops the guest if it runs, then deletes it and its disk. @param {string} name */
    async remove(name) {
      assertVmName(name);
      if ((await list()).some((g) => g.name === name && g.running)) await tart(['stop', name, '--timeout', '10']);
      await tart(['delete', name]);
    },
  };
}
