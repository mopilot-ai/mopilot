// The children this Host started (an ACP agent, a `codex app-server`, a Claude Code process), kept in `<data dir>/children.json`, so a Host that was killed hard (kill -9, the OOM killer, a reboot) does not leave them running: the next Host on the data dir ends the ones its predecessor left, after it holds the lock and before it records its own.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const { processStart } = require('../../electron/platform/processIdentity.cjs');
const { spawnCore } = require('../../electron/platform/coreChild.cjs');

/** How far a process's start time may be from the one recorded and still be the same process (the record is made as it is spawned, and a clock can step a little). */
const SAME_PROCESS_MS = 5000;
/** How long a child gets to leave after SIGTERM before SIGKILL. */
const GRACE_MS = 3000;

/** A clock can step a little: a process this close to the time of writing counts as the one that wrote. */
const WRITE_SLACK_MS = 2000;
/**
 * Whether the process with this pid started after the file naming it was written, so it cannot be the process the file means: after a reboot the number can be anyone. False when the core cannot say.
 * @param {number} pid
 * @param {number} writtenAt the file's mtime (ms)
 * @param {(pid: number) => Promise<number | null> | number | null} [startOf]
 * @returns {Promise<boolean>}
 */
export async function startedAfterWriting(pid, writtenAt, startOf = processStart) {
  const at = await startOf(pid);
  return at !== null && at > writtenAt + WRITE_SLACK_MS;
}

/** Whether a signal can reach the process (EPERM: it exists, but is not ours). @param {number} pid */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM';
  }
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {(pid: number) => Promise<number | null> | number | null} [o.startOf] when a process started (ms), or null
 * @param {(pid: number, signal: NodeJS.Signals | 0, group: boolean) => void} [o.signal] sends a signal to a process, or its process group; throws when there is none
 * @param {(pid: number) => boolean} [o.alive]
 * @param {() => number} [o.now]
 * @param {number} [o.graceMs]
 * @param {(message: string) => void} [o.report]
 */
export function createChildren({
  dataDir,
  startOf = processStart,
  signal = (pid, sig, group) => void process.kill(group ? -pid : pid, sig),
  alive = isAlive,
  now = Date.now,
  graceMs = GRACE_MS,
  report = () => undefined,
}) {
  const file = path.join(dataDir, 'children.json');
  /** The children running now: pid -> what is known of them. @type {Map<number, { label: string, startedAt: number }>} */
  const running = new Map();
  /** Nothing is written until the predecessor's file has been read: this Host may not hold the lock yet. */
  let armed = false;

  function write() {
    if (!armed) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ hostPid: process.pid, children: [...running].map(([pid, c]) => ({ pid, ...c })) }), {
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
    } catch (e) {
      // a child that is not on the list is left behind by a hard kill, which is no worse than before
      report(`children.json: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** What the previous run left on disk. @returns {{ pid: number, label: string, startedAt: number }[]} */
  function previous() {
    try {
      const found = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(found.children) ? found.children.filter((/** @type {any} */ c) => Number.isInteger(c?.pid) && c.pid > 1) : [];
    } catch {
      return [];
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** End a process and what it started: its group first (the children are started in one), the process alone otherwise. @param {number} pid @param {NodeJS.Signals} sig */
  function send(pid, sig) {
    try {
      signal(pid, sig, true);
    } catch {
      try {
        signal(pid, sig, false);
      } catch {
        // gone already
      }
    }
  }

  /** Whether the process group `pid` leads still has a member (a group's number is not reused while it has one). @param {number} pid */
  function groupAlive(pid) {
    try {
      signal(pid, 0, true);
      return true;
    } catch {
      return false;
    }
  }

  /** Remember a child. @param {number} pid @param {string} label */
  function track(pid, label) {
    running.set(pid, { label, startedAt: now() });
    write();
  }

  /** @param {number} pid */
  function untrack(pid) {
    if (running.delete(pid)) write();
  }

  /** Follow a child process object: tracked now, forgotten when it exits. @param {import('node:child_process').ChildProcess} child @param {string} label */
  function watch(child, label) {
    const { pid } = child;
    if (!pid) return;
    track(pid, label);
    child.once('exit', () => untrack(pid));
  }

  return {
    track,
    untrack,
    watch,
    /** The children now running, by pid. */
    list: () => [...running.keys()],
    /**
     * Stopping: end every child this Host still has, the way the next Host would end what a hard kill left (SIGTERM, then SIGKILL after the grace), so a child that will not leave never keeps a stopping Host alive for minutes (it stopped serving at once, and the app read it as offline until it exited).
     * @returns {Promise<number[]>} the pids that were ended
     */
    async endAll() {
      /** @type {Set<number>} */
      const ended = new Set();
      // a child a turn started while the others were leaving is ended in a further pass; three passes bound a Host that keeps being asked for more
      for (let pass = 0; pass < 3 && running.size > 0; pass++) {
        const mine = [...running.keys()];
        for (const pid of mine) send(pid, 'SIGTERM'), ended.add(pid);
        const end = now() + graceMs;
        // only a pid this Host still holds a handle for is signalled: one whose child already exited was forgotten on its 'exit' and could be anyone's now
        while (mine.some((pid) => running.has(pid) && alive(pid)) && now() < end) await sleep(50);
        for (const pid of mine) if (running.has(pid) && alive(pid)) send(pid, 'SIGKILL');
        // a leader that left on SIGTERM may have left a member of its group that did not: while the group exists its number cannot be anyone else's, so the group is ended too
        for (const pid of mine) if (!alive(pid) && groupAlive(pid)) send(pid, 'SIGKILL');
        // gone now: forgotten here too, so the next pass sees only what is new
        for (const pid of mine) if (!alive(pid)) untrack(pid);
      }
      return [...ended];
    },
    /**
     * End the children the previous run left, then start recording this run's. Call it once, after this Host holds the data dir's lock.
     * A pid that is now another process (its start time is not the recorded one) is left alone.
     * @returns {Promise<number[]>} the pids that were ended
     */
    async start() {
      const stale = [];
      for (const c of previous()) {
        const at = await startOf(c.pid);
        if (c.pid !== process.pid && at !== null && Math.abs(at - c.startedAt) <= SAME_PROCESS_MS) stale.push(c);
      }
      armed = true;
      write();
      for (const c of stale) send(c.pid, 'SIGTERM');
      const end = now() + graceMs;
      while (stale.some((c) => alive(c.pid)) && now() < end) await sleep(50);
      for (const c of stale) if (alive(c.pid)) send(c.pid, 'SIGKILL');
      return stale.map((c) => c.pid);
    },
    /**
     * `node:child_process` with every `spawn` recorded, and every harness process the core starts (`spawnOwned`), to put
     * behind the proc port (electron/platform/ports/proc.cjs).
     * @param {typeof import('node:child_process')} [real] @param {(...a: any[]) => any} [owned]
     */
    tracking(real = childProcess, owned = spawnCore) {
      const tracked =
        (/** @type {(...a: any[]) => any} */ spawn) =>
        (/** @type {string} */ command, /** @type {any[]} */ ...rest) => {
          const child = spawn(command, ...rest);
          watch(child, path.basename(String(command)));
          return child;
        };
      return new Proxy(real, {
        get(target, key) {
          if (key === 'spawn') return tracked(target.spawn);
          return key === 'spawnOwned' ? tracked(owned) : Reflect.get(target, key);
        },
      });
    },
  };
}
