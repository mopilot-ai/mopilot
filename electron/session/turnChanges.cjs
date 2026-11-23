// Per-turn file changes: Git tree snapshots of a thread's working folder at turn start and end, and the diff between them.

const { proc } = require('../platform/ports/proc.cjs');
const { promisify } = require('node:util');
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const { overlappingDirectories } = require('./workspaceOverlap.cjs');
const { normalizeDiffCache } = require('../platform/turnDiffCache.cjs');
const { noteIgnored } = require('../ignored.cjs');
const shellEnv = require('../platform/env.cjs');
/**
 * execFile as a promise, through the port as it is when called.
 * @param {string} file @param {string[]} args @param {import('node:child_process').ExecFileOptions} options
 */
const exec = (file, args, options) =>
  /** @type {Promise<{ stdout: string, stderr: string }>} */ (promisify(proc.execFile)(file, args, options));

// the login shell's environment by default: a Dock launch's own PATH is launchd's, which misses the user's git (#1580)
async function git(cwd, args, env = shellEnv.gitEnv()) {
  const { stdout } = await exec('git', args, { cwd, env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

const tree = require('../../shared/turnTree.mjs');

/** The snapshot, HEAD and tree comparison of shared/turnTree.mjs, run with this Mac's git and the login shell's environment. */
const deps = () => ({ git, env: () => shellEnv.gitEnv(), fs: fs.promises, tmpdir: () => os.tmpdir(), ignored: noteIgnored });

/** Capture working contents in a private index, preserving the user's index and HEAD. */
const snapshot = (cwd) => tree.snapshotTree(deps(), cwd);

/** Where the folder's HEAD is: its commit and how many reflog entries it holds, or null. @returns {Promise<{ id: string, log: number } | null>} */
const headOf = (cwd) => tree.headOf(git, cwd);

/** The diff between two snapshots, leaving out what a checkout, pull or reset between them brought in (#2482). */
const compareTrees = (cwd, before, after, heads) => tree.compareTrees(git, cwd, before, after, heads);

/** Threads whose saved turns stay in memory when there is a store to read the rest from. */
const CACHED_THREADS = 8;

/** Items that only carry text: the model cannot change a file through them. */
const NON_WRITING_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan']);

/** Baselines belong to individual threads, never to the current branch or the real Git index. */
class TurnChanges {
  constructor(
    capture = snapshot,
    compare = compareTrees,
    /** @type {{ read(threadId: string): unknown, write(threadId: string, turns: Record<string, string>): void, flushSync?(): void, migrated?: boolean } | null} */ store = null,
    resolveScope = (cwd) => fs.realpathSync(cwd),
    /** the folder's HEAD, taken with each snapshot so a checkout between two of them can be told apart from an edit */
    head = capture === snapshot ? headOf : () => null,
  ) {
    this.head = head;
    this.resolveScope = resolveScope;
    this.capture = capture;
    this.compare = compare;
    this.baselines = new Map();
    this.finishing = new Set();
    this.store = store;
    /** @type {Map<string, Record<string, string>>} chats' saved turns, read from the store when first asked for */
    this.diffs = new Map();
    /** @type {{ keep(scope: string, threadId: string, turnId: string, tree: string): Promise<unknown> } | null} set by main */
    this.checkpoints = null;
  }
  /**
   * Snapshot the thread's folder as its turn starts. The caller need not wait: the turn may start alongside it
   * (#1651), finish() waits for it, and a tool item that starts before it is taken voids it (itemStarted).
   * @returns {Promise<void>} settles when the snapshot is taken or has failed; never rejects
   */
  begin(threadId, cwd) {
    // the thread's previous turn may still be taking its final snapshot: this one waits for it (captureStart)
    this.baselines.delete(threadId);
    const baseline = {
      threadId,
      cwd,
      scope: /** @type {string | null} */ (null),
      tree: /** @type {string | null} */ (null),
      head: /** @type {string | null} */ (null),
      shared: false,
      /** keep its start tree for a rewind (finish's `checkpoint`) */
      checkpoint: false,
      /** a tool item started before the snapshot was taken: it may hold that item's writes */
      raced: false,
      settled: false,
      ready: Promise.resolve(),
      /** settles once its final snapshot is taken or given up (finish) */
      /** @type {Promise<unknown>} */
      done: Promise.resolve(),
    };
    this.baselines.set(threadId, baseline);
    baseline.ready = this.captureStart(baseline);
    return baseline.ready;
  }
  async captureStart(baseline) {
    try {
      if (!baseline.cwd) throw new Error('The turn has no working directory.');
      baseline.scope = this.resolveScope(baseline.cwd);
      // the thread's own previous turn ended before this one: its final snapshot comes first, and is no overlap
      const previous = [...this.finishing].filter((other) => other.threadId === baseline.threadId);
      if (previous.length) await Promise.all(previous.map((other) => other.done));
      // aborted or replaced while it waited: a retired turn reserves nothing
      if (this.baselines.get(baseline.threadId) !== baseline) return;
      for (const other of [...this.baselines.values(), ...this.finishing]) {
        if (other === baseline || previous.includes(other)) continue;
        if (overlappingDirectories(other.scope, baseline.scope)) {
          other.shared = true;
          baseline.shared = true;
        }
      }
      const tree = await this.capture(baseline.scope);
      const head = await this.head(baseline.scope);
      if (this.baselines.get(baseline.threadId) === baseline) Object.assign(baseline, { tree, head });
    } catch {
      // An unknown physical scope cannot prove that any concurrent snapshot is independent.
      if (baseline.scope === null) for (const other of [...this.baselines.values(), ...this.finishing]) other.shared = true;
      // The turn may still write after capture fails. Keep its overlap reservation until finish, abort or clear.
      baseline.shared = true;
    } finally {
      baseline.settled = true;
    }
  }
  /**
   * An item of the thread's running turn started: one that may write, before the start snapshot exists, voids it, and
   * so it does for the previous turn's final snapshot still being taken, which could hold its writes.
   */
  itemStarted(threadId, item) {
    if (NON_WRITING_ITEMS.has(item?.type)) return;
    const baseline = this.baselines.get(threadId);
    if (baseline && !baseline.settled) baseline.raced = true;
    for (const other of this.finishing) if (other.threadId === threadId) other.shared = true;
  }
  scopeCurrent(baseline) {
    return this.resolveScope(baseline.cwd) === baseline.scope;
  }
  /**
   * Whether a turn runs, or takes its final snapshot, in a folder overlapping `cwd` (a rewind's restore would write
   * under it). Unreadable: say so, so nothing is restored.
   */
  busyAt(cwd) {
    let scope;
    try {
      scope = this.resolveScope(cwd);
    } catch {
      return true;
    }
    // a turn with no folder known writes nowhere a restore could see
    return [...this.baselines.values(), ...this.finishing].some((b) => b.scope !== null && overlappingDirectories(b.scope, scope));
  }
  /** A rewind wrote files under `cwd`: a turn over it there can no longer tell its own changes apart. */
  shareAt(cwd) {
    for (const b of [...this.baselines.values(), ...this.finishing]) {
      try {
        if (b.scope === null || overlappingDirectories(b.scope, this.resolveScope(cwd))) b.shared = true;
      } catch {
        b.shared = true;
      }
    }
  }
  /** `checkpoint`: keep the tree the turn started from for a rewind (Codex, whose rewind restores files). */
  async finish(threadId, turnId, { checkpoint = false } = {}) {
    const pending = this.baselines.get(threadId);
    // A turn that ends before its start snapshot is taken waits for it; an abort or a newer turn meanwhile owns the thread.
    if (pending && !pending.settled) await pending.ready;
    const baseline = this.baselines.get(threadId);
    if (baseline !== pending) return undefined;
    this.baselines.delete(threadId);
    if (!baseline || baseline.tree === null || baseline.shared || baseline.raced) return undefined;
    baseline.checkpoint = checkpoint;
    // A final snapshot still reads the working folder. Keep it visible to new turns
    // until finalization settles, then fall back to native attribution if it overlapped.
    this.finishing.add(baseline);
    const run = this.finalSnapshot(baseline, turnId);
    // the thread's next turn waits for it (captureStart); `run` never rejects
    baseline.done = run;
    return run;
  }
  /** The final snapshot of a turn in `finishing`, and its diff against the start, kept under `turnId`. */
  async finalSnapshot(baseline, turnId) {
    const { threadId } = baseline;
    try {
      if (!this.scopeCurrent(baseline)) return undefined;
      const after = await this.capture(baseline.scope);
      const head = await this.head(baseline.scope);
      if (baseline.shared || !this.scopeCurrent(baseline)) return undefined;
      // the tree the turn started from, kept so a rewind to before it can bring its files back (turnCheckpoints.cjs);
      // also when the diff is too big to read. Never waited for, and its failure is the turn's checkpoint only.
      if (turnId && baseline.checkpoint && this.checkpoints)
        Promise.resolve()
          .then(() => this.checkpoints?.keep(baseline.scope, threadId, turnId, baseline.tree))
          .catch((error) => noteIgnored("keep a turn's file checkpoint", error));
      const diff = await this.compare(baseline.scope, baseline.tree, after, { before: baseline.head, after: head });
      if (baseline.shared || !this.scopeCurrent(baseline)) return undefined;
      if (turnId) {
        const turns = /** @type {Record<string, string>} */ (this.turnsOf(threadId, true));
        turns[turnId] = diff;
        this.store?.write(threadId, turns);
      }
      return diff;
    } catch {
      // Failed snapshots and comparisons retain the harness's native attribution.
    } finally {
      this.finishing.delete(baseline);
    }
  }
  /**
   * What the thread's running turn changed so far, for a live view; undefined when its snapshot can't say (none, it
   * overlaps another turn, it raced a tool) or the turn ended while it was read.
   */
  async peek(threadId) {
    const baseline = this.baselines.get(threadId);
    if (!baseline) return undefined;
    await baseline.ready;
    const usable = () => this.baselines.get(threadId) === baseline && baseline.tree !== null && !baseline.shared && !baseline.raced;
    try {
      if (!usable() || !this.scopeCurrent(baseline)) return undefined;
      const now = await this.capture(baseline.scope);
      const head = await this.head(baseline.scope);
      if (!usable()) return undefined;
      const diff = await this.compare(baseline.scope, baseline.tree, now, { before: baseline.head, after: head });
      return usable() && this.scopeCurrent(baseline) ? diff : undefined;
    } catch {
      // a failed read leaves the live view as it was; the final snapshot still runs
      return undefined;
    }
  }
  /**
   * The thread's saved turns (turn id -> diff): read from the store the first time it is asked for, and kept for the
   * next. With a store, only the most recently used threads stay in memory; what is not yet written the store holds.
   * @returns {Record<string, string> | undefined} undefined when none are saved and `create` is not set
   */
  turnsOf(threadId, create = false) {
    let turns = this.diffs.get(threadId);
    if (turns) this.diffs.delete(threadId);
    else {
      const stored = this.store?.read(threadId);
      turns = (stored ? normalizeDiffCache({ [threadId]: stored })[threadId] : undefined) ?? (create ? Object.create(null) : undefined);
    }
    // while the store still moves its old file in, what it says of a thread may be partial: ask again next time
    if (turns && this.store?.migrated !== false) {
      this.diffs.set(threadId, turns);
      if (this.store && this.diffs.size > CACHED_THREADS) this.diffs.delete(this.diffs.keys().next().value);
    }
    return turns;
  }
  /** Write what the store still holds (a quit). */
  flush() {
    this.store?.flushSync?.();
  }
  /** The saved diff of one of the thread's turns, or undefined. */
  saved(threadId, turnId) {
    return this.turnsOf(threadId)?.[turnId];
  }
  abort(threadId) {
    this.baselines.delete(threadId);
    for (const baseline of this.finishing) if (baseline.threadId === threadId) baseline.shared = true;
  }
  clear() {
    this.baselines.clear();
    for (const baseline of this.finishing) baseline.shared = true;
  }
  restore(threadId, turns) {
    const saved = this.turnsOf(threadId);
    return turns.map((turn) => {
      const diff = saved?.[turn.id];
      return diff === undefined ? turn : { ...turn, diff };
    });
  }
}

module.exports = { TurnChanges, compareTrees, headOf };
