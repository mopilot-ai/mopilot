// The "+N −M" a chat's row shows in a phone's list: the lines of tracked files its folder has changed since the last commit, as two numbers. Read once per folder and kept briefly, with a deadline, so a long list never waits on Git; it never takes Git's index lock (a commit in the same repository is not disturbed) and has its own few Git slots (the Changes screen is not queued behind a list).
const { readHeadDiff } = require('../../platform/gitDiff.cjs');
const { parseNumstatZ } = require('../../platform/gitParse.cjs');
const { GIT_DIFF_FLAGS } = require('../../../shared/gitDiffFlags.mjs');

/** How long a folder's numbers are reused, how long a list waits for the ones still being read, and how many folders are remembered. */
const TTL_MS = 15_000;
/** A folder Git could not answer for (not a repository, too slow) is not asked again for this long. */
const FAILED_TTL_MS = 60_000;
const BUDGET_MS = 1_500;
const MAX_FOLDERS = 200;

/**
 * @param {object} o
 * @param {Parameters<typeof readHeadDiff>[0]} o.run one git command, resolved with its outcome (review/ops.cjs, at most a few at a time)
 * @param {(chatId: string) => Promise<string | null>} o.cwdOf the chat's folder, on any harness
 * @param {() => number} [o.now]
 */
function createChatStats({ run: git, cwdOf, now = Date.now }) {
  // a read for the list only looks: Git is told not to refresh the index, which would take its lock
  const run = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {{ cwd: string }} */ o) =>
    git(cmd, ['--no-optional-locks', ...args], o);
  /** @type {Map<string, { at: number, ttl: number, stat: Promise<{ added: number, removed: number } | null> }>} */
  const folders = new Map();

  /** The folder's numbers, or null when it is not a repository or Git could not say. */
  async function read(/** @type {string} */ cwd) {
    try {
      const out = await readHeadDiff(run, cwd, [...GIT_DIFF_FLAGS, '--numstat', '-z']);
      let added = 0;
      let removed = 0;
      for (const file of Object.values(parseNumstatZ(out.stdout))) {
        added += file.added;
        removed += file.removed;
      }
      return { added, removed };
    } catch {
      return null;
    }
  }

  function statOf(/** @type {string} */ cwd) {
    const known = folders.get(cwd);
    if (known && now() - known.at < known.ttl) return known.stat;
    if (folders.size >= MAX_FOLDERS) folders.clear();
    const entry = { at: now(), ttl: TTL_MS, stat: read(cwd) };
    // what could not be read is asked for again less often
    void entry.stat.then((stat) => {
      if (!stat) entry.ttl = FAILED_TTL_MS;
    });
    folders.set(cwd, entry);
    return entry.stat;
  }

  return {
    /**
     * The numbers of the chats whose folders answered within the deadline; a folder still being read answers the next time, and a chat
     * with no folder or no repository is left out.
     * @returns {Promise<Map<string, { added: number, removed: number }>>}
     */
    async statsFor(/** @type {string[]} */ chatIds, budgetMs = BUDGET_MS) {
      /** @type {Map<string, { added: number, removed: number }>} */
      const found = new Map();
      const reads = chatIds.map(async (id) => {
        let cwd;
        try {
          cwd = await cwdOf(id);
        } catch {
          return;
        }
        const stat = cwd ? await statOf(cwd) : null;
        if (stat) found.set(id, stat);
      });
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      });
      await Promise.race([Promise.all(reads), deadline]);
      clearTimeout(timer);
      // what was found after the deadline is for the next list, not this one
      return new Map(found);
    },
  };
}

module.exports = { createChatStats, TTL_MS, FAILED_TTL_MS, BUDGET_MS, MAX_FOLDERS };
