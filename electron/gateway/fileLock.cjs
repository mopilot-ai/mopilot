// One owner at a time for a sealed or trust folder (#2139; MoMo's folder and its stores): an exclusive lock file (O_EXCL) holding the owner's pid and the time that process started, taken for the owner's lifetime, so a second writer (a dev instance on the same folder, a second instance in this process) is refused instead of forking the audit chain or undoing a revoke. A lock whose process no longer runs, or whose pid now belongs to a process that started at another time (a reboot, pid reuse), is taken over; an empty lock is live only while it is new (its taker is still writing it). The folder is on this Mac's own disk (~/Library/Application Support): two Macs sharing a network home would each see the other's pid as gone.
const { processStart } = require('../platform/processIdentity.cjs');
const crypto = require('node:crypto');
const path = require('node:path');

/** How long an empty lock file counts as being written. */
const EMPTY_GRACE = 10_000;
/** How far a recorded start time may be from the kernel's for one process (the recorder estimates it; the wall clock may be adjusted). */
const START_SLACK = 60_000;

class LockError extends Error {
  constructor(/** @type {string} */ message) {
    super(message);
    this.code = 'locked';
  }
}

/** Whether a process with this pid is running (EPERM: it is, as another user). */
function pidAlive(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e)?.code === 'EPERM';
  }
}

/**
 * This process as a lock or a run records its owner, with its start as the kernel has it: another process reads the same
 * value, so a clock stepped since launch can't make a live owner a stranger, as an estimate from the clock would. The
 * estimate when the core can't say.
 * @param {(pid: number) => Promise<number | null>} [startOf]
 */
async function ownProcess(startOf = processStart) {
  const started = (await startOf(process.pid)) ?? Date.now() - process.uptime() * 1000;
  return { pid: process.pid, started: Math.round(started) };
}

/** The lock file's text, '' when it is gone. */
async function readLock(/** @type {typeof import('node:fs/promises')} */ fs, /** @type {string} */ file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return '';
    throw e;
  }
}

/** The owner a lock file names, or null when it names none (empty, cut short, an older format). */
function ownerOf(/** @type {string} */ text) {
  try {
    const o = JSON.parse(text);
    return Number.isSafeInteger(o?.pid) && o.pid > 0 && Number.isFinite(o.started)
      ? /** @type {{ pid: number, started: number }} */ (o)
      : null;
  } catch {
    // not one of ours: judged by its age
    return null;
  }
}

/**
 * Takes the lock in `file`; resolves with its release.
 * @param {{ fs: typeof import('node:fs/promises'), file: string, pid?: number, started?: number, isAlive?: (pid: number) => boolean,
 *           startOf?: (pid: number) => Promise<number | null>, now?: () => number }} o
 *   pid, started: who takes it (this process, as ownProcess reads it, by default); isAlive, startOf: how an owner is checked (tests)
 * @returns {Promise<{ release(): Promise<void> }>}
 */
async function acquireLock({ fs, file, pid = process.pid, started, isAlive = pidAlive, startOf = processStart, now = Date.now }) {
  const mine = JSON.stringify({ pid, started: Math.round(started ?? (await ownProcess(startOf)).started) });
  const busy = (/** @type {number | string} */ who) =>
    new LockError(`${path.basename(path.dirname(file))} is in use by another MoPilot process (${who})`);
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fs.open(file, 'wx', 0o600);
      try {
        await fh.write(mine);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return {
        release: async () => {
          // only our own lock: a taken-over one belongs to someone else now
          if ((await readLock(fs, file)) === mine) await fs.rm(file, { force: true });
        },
      };
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'EEXIST') throw e;
    }
    if (attempt > 0) throw busy('unknown');
    const text = await readLock(fs, file);
    const owner = ownerOf(text);
    if (owner) {
      if (isAlive(owner.pid)) {
        const s = await startOf(owner.pid);
        // can't tell when it started: count it as the owner
        if (s === null || Math.abs(s - owner.started) <= START_SLACK) throw busy(owner.pid);
      }
    } else if (text === '' || !text.trim()) {
      const age = await fs.stat(file).then(
        (st) => now() - st.mtimeMs,
        () => Number.POSITIVE_INFINITY,
      );
      if (age < EMPTY_GRACE) throw busy('starting');
    }
    // stale: move it aside in one step, and make sure what moved is the lock judged stale, not one taken meanwhile
    const aside = `${file}.stale-${crypto.randomUUID()}`;
    try {
      await fs.rename(file, aside);
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
      // already gone: try to take it again
      continue;
    }
    if ((await readLock(fs, aside)) !== text) {
      await fs.rename(aside, file);
      throw busy('taking over');
    }
    await fs.rm(aside, { force: true });
  }
}

module.exports = { acquireLock, ownProcess, LockError, pidAlive, EMPTY_GRACE, START_SLACK };
