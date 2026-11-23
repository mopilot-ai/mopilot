// Port blocks for managed worktrees: each worktree folder keeps one block of consecutive ports, recorded in one file so every MoPilot build on the machine shares it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeAtomic } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { PORTS_PER_WORKTREE } = require('./worktreeEnv.cjs');

/**
 * Clear of the usual dev-server ports and below macOS's and Windows's ephemeral range (49152 and up). Linux's default
 * ephemeral range (32768 to 60999) does include these, and no port is probed: a block is reserved, not known to be free.
 */
const FIRST_PORT = 42000;
const BLOCKS = 500;
/** How long a change waits for another process's change to the table, and when that other one is taken for dead. */
const LOCK_TRIES = 50;
const LOCK_WAIT_MS = 10;
const LOCK_STALE_MS = 10_000;

const validBase = (n) =>
  Number.isInteger(n) && n >= FIRST_PORT && n < FIRST_PORT + BLOCKS * PORTS_PER_WORKTREE && (n - FIRST_PORT) % PORTS_PER_WORKTREE === 0;

/** Whether `file` is in the account's real home while the node test runner runs: a test must not write there. */
function realHomeUnderTest(file, env = process.env) {
  if (!env.NODE_TEST_CONTEXT) return false;
  const rel = path.relative(os.userInfo().homedir, path.resolve(file));
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

const pause = (ms) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * @param {{ file: () => string, exists?: (dir: string) => boolean, env?: NodeJS.ProcessEnv, wait?: (ms: number) => void, now?: () => number }} opts
 * `file`: where the JSON map of worktree folder to the first port of its block is, asked each time (the home folder
 * can change under test)
 */
function createPorts({ file, exists = fs.existsSync, env = process.env, wait = pause, now = Date.now }) {
  /** The recorded blocks, without entries that are not a block or that share one with an earlier entry. */
  function read() {
    const raw = readJson(file());
    /** @type {Record<string, number>} */
    const map = {};
    const taken = new Set();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
    for (const [dir, base] of Object.entries(raw)) {
      if (!validBase(base) || taken.has(base)) continue;
      taken.add(base);
      map[dir] = base;
    }
    return map;
  }

  function write(map) {
    try {
      writeAtomic(file(), JSON.stringify(map));
    } catch (error) {
      // an unwritable home: this run still gets its block, and the next one may get another
      noteIgnored('record a worktree port block', error);
    }
  }

  /**
   * Run one read-change-write of the table while no other process runs one: a lock folder beside the table, taken over
   * when its holder has been gone too long. A lock that cannot be had (an unwritable home, a holder that never ends)
   * does not stop a terminal from opening: the change then runs unlocked.
   * @template T @param {() => T} change @returns {T}
   */
  function locked(change) {
    const lock = `${file()}.lock`;
    let held = false;
    let tries = 0;
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    } catch (error) {
      noteIgnored("make the worktree port table's folder", error);
      tries = LOCK_TRIES;
    }
    for (; tries < LOCK_TRIES && !held; tries++) {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        held = true;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          noteIgnored('lock the worktree port table', error);
          break;
        }
        const age = now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? now());
        if (age > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
        else wait(LOCK_WAIT_MS);
      }
    }
    try {
      return change();
    } finally {
      if (held) fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  /**
   * The first port of `dir`'s block, the same one every time while the worktree exists; null when every block is taken.
   * A new block is handed out after giving up the blocks of worktree folders that are gone, however they went.
   * @param {string} dir the worktree folder, spelled the same way by every caller
   * @returns {number | null}
   */
  function portFor(dir) {
    if (realHomeUnderTest(file(), env)) return null;
    const known = read()[dir];
    if (known !== undefined) return known;
    return locked(() => {
      // read again: another process may have changed the table before this one got the lock
      const map = read();
      if (map[dir] !== undefined) return map[dir];
      for (const other of Object.keys(map)) if (!exists(other)) delete map[other];
      const taken = new Set(Object.values(map));
      for (let i = 0; i < BLOCKS; i++) {
        const base = FIRST_PORT + i * PORTS_PER_WORKTREE;
        if (taken.has(base)) continue;
        map[dir] = base;
        write(map);
        return base;
      }
      return null;
    });
  }

  /** Give up `dir`'s block (its worktree was removed). */
  function release(dir) {
    if (realHomeUnderTest(file(), env)) return;
    if (read()[dir] === undefined) return;
    locked(() => {
      const map = read();
      delete map[dir];
      write(map);
    });
  }

  return { portFor, release };
}

module.exports = { createPorts, realHomeUnderTest, FIRST_PORT, BLOCKS, LOCK_TRIES, LOCK_STALE_MS };
