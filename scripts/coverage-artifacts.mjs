// Owns one coverage run's raw V8 traces: a pid-named scratch folder. A completed run removes only its verified traces;
// the folders of failed or interrupted runs are kept as evidence briefly, in sibling worktrees too, and ambiguous ones are never touched.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = /^run-(\d+)-/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// a pid-named run folder; pid-less folders and loose traces (older versions) have no provable owner and are left alone
const KEPT = '.kept';
/** How many dead runs' folders are kept as evidence, and for how long. */
export const PRESERVED_RUNS = 2;
export const PRESERVED_MS = 24 * 60 * 60 * 1000;
/** A sibling worktree's dead runs: an agent worktree may never run tests again, so nothing else would prune them. */
export const SIBLING_PRESERVED_RUNS = 1;
export const SIBLING_PRESERVED_MS = 60 * 60 * 1000;

/** Whether a process with this id exists; EPERM means it does, under another user. */
export function processAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** Whether a file starts like a raw V8 coverage trace (`{"result":[`), without reading the rest of a large one. */
function isRawTrace(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(32);
    return readSync(fd, head, 0, 32, 0) > 0 && /^\s*\{\s*"result"\s*:\s*\[/.test(head.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/**
 * Prune the run folders under `parent` whose process is gone: a --keep-raw one at once (as asked), the others (a run that
 * failed, threw or was killed, whose traces are its evidence) down to the newest `keepRuns` younger than `keepMs`. A live
 * run's folder, a pid-less folder and loose traces of older versions are left alone: nothing proves no producer still
 * writes there. Anything else there is left alone too, since --reports-dir may name any folder. Raw traces of one run are
 * 0.1-1.4 GB, so keeping every failed run filled the disk across agent worktrees. `keptForMs` spares a --keep-raw folder
 * younger than that, for a pruner that is not the next run of the same reports directory.
 */
export function pruneRawRuns(
  parent,
  {
    alive = processAlive,
    log = console.warn,
    remove = rmSync,
    now = Date.now,
    keepRuns = PRESERVED_RUNS,
    keepMs = PRESERVED_MS,
    keptForMs = 0,
  } = {},
) {
  let entries;
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  const dead = [];
  for (const name of entries) {
    const owner = RUN.exec(name);
    if (!owner || alive(Number(owner[1]))) continue;
    const dir = path.join(parent, name);
    let at;
    try {
      at = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const kept = existsSync(path.join(dir, KEPT));
    dead.push({ dir, at, kept });
  }
  dead.sort((a, b) => b.at - a.at);
  let preserved = 0;
  for (const { dir, at, kept } of dead) {
    if (kept && keptForMs > 0 && now() - at < keptForMs) continue;
    if (!kept && preserved < keepRuns && now() - at < keepMs) {
      preserved++;
      continue;
    }
    try {
      remove(dir, { recursive: true, force: true });
    } catch (error) {
      log(`Could not remove old raw coverage ${dir}: ${error.message}`);
    }
  }
}

/** The paths of every worktree of the repository that contains `cwd`; none outside a repository. */
export function listWorktrees(cwd, run = execFileSync) {
  let out;
  try {
    out = run('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 << 20,
      timeout: 30_000,
    });
  } catch {
    return [];
  }
  return String(out)
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/**
 * The default raw-run folders (`coverage/<name>/tmp`) of this repository's other worktrees, when `parent` lies inside
 * this checkout (`root`); none for a --reports-dir elsewhere, such as a test's temporary folder or another repository.
 */
export function siblingRawParents(parent, { root = REPO_ROOT, worktrees = listWorktrees } = {}) {
  const own = realpathSync(parent);
  const home = realpathSync(root);
  if (!own.startsWith(home + path.sep)) return [];
  const parents = [];
  for (const worktree of worktrees(home)) {
    let names;
    try {
      names = readdirSync(path.join(worktree, 'coverage'));
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(worktree, 'coverage', name, 'tmp');
      if (existsSync(dir) && realpathSync(dir) !== own) parents.push(dir);
    }
  }
  return parents;
}

/**
 * Give each invocation a fresh raw directory named after its process, after pruning dead runs' directories. Call
 * `finish` once every producer and the reporter has ended. A run that did not complete keeps its traces as evidence.
 * A completed one (`ok`) removes only the files that are raw V8 traces, and only once its final report (`final`, when it
 * has one) is newer than every trace; with `keep` (--keep-raw) the traces stay until the next run in the same reports
 * directory removes them. Sibling worktrees' dead runs are pruned too, keeping at most one younger than an hour each and
 * any --keep-raw folder for an hour.
 */
export function rawCoverageRun(
  reportsDir,
  {
    keep = false,
    pid = process.pid,
    alive = processAlive,
    log = console.warn,
    remove = rmSync,
    now = Date.now,
    siblings = siblingRawParents,
  } = {},
) {
  const parent = path.join(reportsDir, 'tmp');
  mkdirSync(parent, { recursive: true });
  pruneRawRuns(parent, { alive, log, remove, now });
  for (const sibling of siblings(parent)) {
    pruneRawRuns(sibling, {
      alive,
      log,
      remove,
      now,
      keepRuns: SIBLING_PRESERVED_RUNS,
      keepMs: SIBLING_PRESERVED_MS,
      keptForMs: SIBLING_PRESERVED_MS,
    });
  }
  const tempDir = mkdtempSync(path.join(parent, `run-${pid}-`));
  return {
    tempDir,
    /** @param {{ ok?: boolean, final?: string }} [outcome] */
    finish({ ok = false, final } = {}) {
      if (keep) {
        writeFileSync(path.join(tempDir, KEPT), '');
        log(`Kept raw coverage in ${tempDir} (--keep-raw); the next run in this reports directory removes it.`);
        return;
      }
      if (!ok) {
        log(`Kept the raw coverage of an incomplete run in ${tempDir}; a later run removes it after a day.`);
        return;
      }
      try {
        const traces = readdirSync(tempDir)
          .map((name) => path.join(tempDir, name))
          .filter((file) => statSync(file).isFile() && file.endsWith('.json') && isRawTrace(file));
        const reportedAt = final ? statSync(final, { throwIfNoEntry: false })?.mtimeMs : Infinity;
        if (final && !traces.every((file) => statSync(file).mtimeMs <= (reportedAt ?? -1))) {
          log(`Kept raw coverage in ${tempDir}: the final report ${final} is missing or older than the traces.`);
          return;
        }
        for (const file of traces) remove(file, { force: true });
        rmdirSync(tempDir);
      } catch (error) {
        log(`Could not remove raw coverage ${tempDir}: ${error.message}`);
      }
    },
  };
}
