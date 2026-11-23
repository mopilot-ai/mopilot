// Unit-worker startup, runtime guards and the machine-wide budget local runs share through process-owned slots; wraps `npm test`.
//
//   node scripts/test-slots.mjs <node --test arguments…>   run node with this run's --test-concurrency, below normal priority

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GIB = 1024 ** 3;
/** Set for the test processes of a run that holds slots: a run started inside one (a test of the runner) takes none. */
export const HELD = 'MOPILOT_TEST_SLOTS';
export const SLOT_DIR = path.join(os.tmpdir(), 'mopilot-unit-test-slots');
/** A slot older than this is free whatever its pid says: the pid may have been reused by a process that is not a run. */
const STALE_MS = 12 * 60 * 60 * 1000;
const POLL_MS = 1000;
const MAX_WAIT_MS = 15 * 60 * 1000;
/** os.setPriority's niceness for local runs (below normal on Windows), so foreground apps and the benchmark VM win the CPU. */
export const LOW_PRIORITY = 10;
/** CI unit files must terminate: a silent test otherwise holds the serialized main validation queue for hours. */
export const CI_TEST_TIMEOUT_MS = 120_000;
/**
 * Makes a test run's processes exit with the command that started them (scripts/exit-with-parent.mjs). --require, not
 * --import: node --test loads --import only into the test files' processes, so the runner itself would outlive a
 * killed command and keep starting files; --require loads into the runner too.
 */
export const EXIT_WITH_PARENT = ['--require', path.join(path.dirname(fileURLToPath(import.meta.url)), 'exit-with-parent.mjs')];
/** Node 24 can double-free dying WASM import wrappers during code GC (nodejs/node#66366); disable that GC in unit workers. */
export const WASM_CODE_GC_GUARD = ['--no-wasm-code-gc'];

/** Inspect the exact Node test-mode argument without starting a run or acquiring workers. @param {unknown} argument */
export function isNodeTestArgument(argument) {
  return argument === '--test';
}

/**
 * How many test files run at once: UNIT_TEST_CONCURRENCY when set; node's default in CI; otherwise one per 8 GiB of
 * memory (two on a 16 GB laptop), since each file's process can take about a gigabyte under coverage. Locally this is
 * the budget every run on the machine shares (startTestRun).
 * @param {Record<string, string | undefined>} env
 */
export function testConcurrency(env, totalmem = os.totalmem(), cpus = os.availableParallelism()) {
  if (env.UNIT_TEST_CONCURRENCY) return env.UNIT_TEST_CONCURRENCY;
  if (env.CI) return null;
  return String(Math.max(1, Math.min(cpus - 1, Math.floor(totalmem / (8 * GIB)))));
}

/** How many slots one run takes at most: half the budget, so two runs split it, but two where the budget has them. */
export function runShare(budget) {
  return Math.max(Math.ceil(budget / 2), Math.min(budget, 2));
}

/** Whether a process exists; one owned by another user (EPERM) does. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The release of a run that holds no slots. */
const nothing = () => undefined;
/** @param {number} ms @returns {void} */
const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Claim up to this run's share of the machine's `budget` slots (no more than `cap`), waiting while every slot is held. A slot is a file
 * linked into place fully written (an atomic claim that fails if it exists), holding its run's pid and token.
 * @returns {{ workers: number, token: string | null, release: () => void }}
 */
export function leaseTestSlots({
  budget,
  cap = Number.POSITIVE_INFINITY,
  dir = SLOT_DIR,
  fs = nodeFs,
  pid = process.pid,
  alive = isAlive,
  now = Date.now,
  sleep = sleepSync,
  log = console.error,
  maxWaitMs = MAX_WAIT_MS,
}) {
  const share = Math.min(runShare(budget), cap);
  const token = `${pid}-${randomUUID()}`;
  const unshared = (why) => {
    log(`Could not use the shared unit-test slots in ${dir} (${why}); running ${share} test files at a time.`);
    return { workers: share, token: null, release: nothing };
  };
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      // gone: released since it was listed; damaged: holds no live claim (a claim is linked in whole). Any other
      // failure to read says nothing about the holder, so it ends the lease instead of taking a live run's slot.
      if (error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) return {};
      throw error;
    }
  };
  const stale = (holder) => !Number.isInteger(holder.pid) || !alive(holder.pid) || !(now() - holder.at < STALE_MS);
  // link `from` to the name `to` unless something is already there: an atomic claim, which never overwrites
  const linked = (from, to) => {
    try {
      fs.linkSync(from, to);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  };
  const claim = (slot) => {
    const draft = path.join(dir, `claim-${token}`);
    fs.writeFileSync(draft, JSON.stringify({ pid, token, at: now() }));
    let won;
    try {
      won = linked(draft, slot);
    } finally {
      fs.unlinkSync(draft);
    }
    return won;
  };
  // Move a dead run's slot aside under a name only this run uses, and free it if what moved is what was judged dead;
  // a claim another run made in between is put back (never over a newer one).
  const reclaim = (slot, holder) => {
    const aside = `${slot}.${token}.reclaim`;
    try {
      fs.renameSync(slot, aside);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (read(aside).token !== holder.token) linked(aside, slot);
    fs.unlinkSync(aside);
  };
  const held = [];
  const take = () => {
    for (let i = 0; i < budget && held.length < share; i++) {
      const slot = path.join(dir, `slot-${i}`);
      if (claim(slot)) {
        held.push(slot);
        continue;
      }
      const holder = read(slot);
      if (holder && !stale(holder)) continue;
      if (holder) reclaim(slot, holder);
      if (claim(slot)) held.push(slot);
    }
  };
  const release = () => {
    for (const slot of held.splice(0)) {
      try {
        if (read(slot)?.token === token) fs.unlinkSync(slot);
      } catch (error) {
        log(`Could not free unit-test slot ${slot} (${error.message}); it frees itself once this run has exited.`);
      }
    }
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return unshared(error.message);
  }
  const start = now();
  for (let waited = false; ; waited = true) {
    try {
      take();
    } catch (error) {
      release();
      return unshared(error.message);
    }
    if (held.length) break;
    if (now() - start >= maxWaitMs) {
      log(`Still no free unit-test slot after ${Math.round(maxWaitMs / 60000)} minutes; running one test file at a time anyway.`);
      return { workers: 1, token: null, release: nothing };
    }
    if (!waited) log(`All ${budget} unit-test slots on this machine are held by other runs; waiting for one to free up.`);
    sleep(POLL_MS);
  }
  return { workers: held.length, token, release };
}

/** Run below normal priority (child processes inherit it), unless already lower; a failure is reported and ignored. */
export function lowerPriority(system = os, log = console.error) {
  try {
    if (system.getPriority() < LOW_PRIORITY) system.setPriority(LOW_PRIORITY);
  } catch (error) {
    log(`Could not lower the test run's priority (${error.message}).`);
  }
}

/** UNIT_TEST_CONCURRENCY as a whole number of workers, or none when unset or not a positive number. */
export function concurrencyCap(env) {
  const n = Math.floor(Number(env.UNIT_TEST_CONCURRENCY));
  return n >= 1 ? n : undefined;
}

/**
 * Start a test run: locally, lower its priority and lease its share of the machine's workers. Locally
 * UNIT_TEST_CONCURRENCY only lowers how many of the shared slots the run takes: a run that set it once skipped the
 * lease, so ten agents each setting it stacked their workers past the budget (load average 777 on 12 cores). CI keeps
 * node's default (or that number), and a run inside a leased run takes one worker.
 * @param {Record<string, string | undefined>} env
 * @returns {{ workers: string | null, env: Record<string, string>, release: () => void }}
 */
export function startTestRun(env, { lease = leaseTestSlots, system = os, log = console.error } = {}) {
  if (env.CI) return { workers: env.UNIT_TEST_CONCURRENCY ?? null, env: {}, release: nothing };
  lowerPriority(system, log);
  if (env[HELD]) return { workers: '1', env: {}, release: nothing };
  const leased = lease({ budget: Number(testConcurrency({ ...env, UNIT_TEST_CONCURRENCY: undefined })), cap: concurrencyCap(env), log });
  return { workers: String(leased.workers), env: leased.token ? { [HELD]: leased.token } : {}, release: leased.release };
}

/**
 * A heavy local step that is not a test run (the pre-commit lint and both TypeScript checks): one slot of the shared
 * budget, below normal priority, so a dozen agents committing at once take turns instead of each adding two tsc
 * processes on top of every test run (#2340). In CI, or inside a leased run, it takes nothing, as a test run does.
 * @param {Record<string, string | undefined>} env
 * @param {Parameters<typeof startTestRun>[1]} [deps]
 */
export function startHeavyStep(env, deps) {
  return startTestRun({ ...env, UNIT_TEST_CONCURRENCY: '1' }, deps);
}

/**
 * The `--test-shard` that UNIT_TEST_SHARD (`<index>/<total>`, as CI's matrix sets it) asks for: node reads it only
 * before the test file patterns, where `npm test -- …` can't put it. None when unset, for a command that is not a
 * test run, or when the arguments already shard; a malformed value throws rather than run every file on each shard.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 */
export function shardArgs(args, env) {
  const shard = env.UNIT_TEST_SHARD;
  if (!shard || !args.some(isNodeTestArgument) || args.some((arg) => arg.startsWith('--test-shard'))) return [];
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`UNIT_TEST_SHARD must look like 2/3 (got ${shard})`);
  return [`--test-shard=${shard}`];
}

/** `npm test`: node with these arguments, as many files at a time as this run leased, and the CI shard it asks for. */
export function main(args, spawn = spawnSync, env = process.env, start = startTestRun) {
  const shard = shardArgs(args, env);
  const run = start(env);
  try {
    const timeout =
      env.CI && args.some(isNodeTestArgument) && !args.some((arg) => arg.startsWith('--test-timeout'))
        ? [`--test-timeout=${CI_TEST_TIMEOUT_MS}`]
        : [];
    const workerArgs = args.some(isNodeTestArgument) ? [...WASM_CODE_GC_GUARD, ...EXIT_WITH_PARENT] : [];
    const workers = run.workers ? [`--test-concurrency=${run.workers}`] : [];
    const result = spawn(process.execPath, [...workerArgs, ...timeout, ...shard, ...workers, ...args], {
      stdio: 'inherit',
      env: { ...env, ...run.env },
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    run.release();
  }
}

// node that cannot start throws, and its error ends the command
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
