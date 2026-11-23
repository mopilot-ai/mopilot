// What the review methods read from the app: a chat's project folder, its changed files in a scope, and a turn's saved diff. Git is run without a shell, read-only, with a time and size limit.
const { execFile } = require('node:child_process');
const shellEnv = require('../../platform/env.cjs');
const { createChanges } = require('./changes.cjs');
const { BRANCH_COMPARISON_GIT_ENV } = require('../../../shared/gitComparisonBase.mjs');
const { createChatStats } = require('./chatStats.cjs');

/** How long one git read may take, and how much output it may return (a larger diff is refused, not cut). */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 8 * 1024 * 1024;

/** How many git processes the phones' reads may have running at once; a flood of requests waits its turn instead of starting a flood of processes. */
const GIT_MAX_PARALLEL = 4;
/** And how many the chat list's line counts may have (their own, so a long list never queues the Changes screen). */
const LIST_GIT_PARALLEL = 2;

/** `run`, at most GIT_MAX_PARALLEL at a time, the rest in arrival order. */
function limited(/** @type {typeof runGit} */ run, max = GIT_MAX_PARALLEL) {
  let active = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  // a finishing read hands its place straight to the next waiting one, so a new request cannot slip in between
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (/** @type {Parameters<typeof runGit>} */ ...args) => {
    if (active >= max) await new Promise((resume) => waiting.push(() => resume(undefined)));
    else active++;
    try {
      return await run(...args);
    } finally {
      release();
    }
  };
}

/** One git command, resolved with its outcome and exit code, never rejecting. */
function runGit(
  /** @type {string} */ _cmd,
  /** @type {string[]} */ args,
  /** @type {{ cwd: string, noLazyFetch?: boolean }} */ { cwd, noLazyFetch },
) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        env: noLazyFetch ? { ...shellEnv.gitEnv(), ...BRANCH_COMPARISON_GIT_ENV } : shellEnv.gitEnv(),
        maxBuffer: GIT_MAX_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: /** @type {any} */ (err)?.code }),
    );
  });
}

/**
 * @param {object} o
 * @param {(chatId: string) => Promise<string | null>} o.cwdOf the chat's folder (session/chatProject.cjs), on any harness
 * @param {{ chats: { records: Map<string, unknown> }, controller: { turnSnapshots?: { liveDiff: (chatId: string) => Promise<{ turnId: string, diff: string } | undefined> } } }} o.live
 *   the app's live objects: the saved chats (one not in it has no turns) and the running turns' snapshots, read when asked
 * @param {(chatId: string, record: unknown) => Promise<{ turns: { id: string, diff?: string }[] }>} o.history the chat's turns with their saved diffs
 * @param {Parameters<typeof createChanges>[0]['run']} [o.run]
 */
function createReviewOps({ cwdOf, live, history, run = runGit }) {
  const changes = createChanges({ run: limited(run) });
  const stats = createChatStats({ run: limited(run, LIST_GIT_PARALLEL), cwdOf });
  return {
    folderOf: cwdOf,
    /** The "+N −M" of each chat's folder for the phone's list (review/chatStats.cjs). */
    statsFor: stats.statsFor,
    files: changes.filesOf,
    /**
     * A turn's diff and which turn it is: the running turn's so far when it is the one named (or none is named), else the
     * saved diff of the named turn, or of the latest turn that has one; undefined when there is none.
     * @returns {Promise<{ turnId: string, diff: string, live: boolean } | undefined>}
     */
    async turnDiff(/** @type {string} */ chatId, /** @type {string | null} */ turnId) {
      const running = await live.controller.turnSnapshots?.liveDiff(chatId);
      if (running && (turnId === null || turnId === running.turnId)) return { ...running, live: true };
      const record = live.chats.records.get(chatId);
      const turns = (record === undefined ? [] : (await history(chatId, record)).turns).filter((t) => typeof t.diff === 'string');
      const found = turnId === null ? turns.at(-1) : turns.find((t) => t.id === turnId);
      return found ? { turnId: found.id, diff: /** @type {string} */ (found.diff), live: false } : undefined;
    },
  };
}

module.exports = { createReviewOps, runGit, GIT_MAX_PARALLEL };
