// Which managed worktree holders to prune past the auto-delete limit, and why one is kept (#3909). Built over platform/git.cjs's
// primitives (injected: git.cjs owns them, and this module would otherwise require it back).
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { touchesRealRootUnderTest } = require('./realWorktreeRoot.cjs');

/** Ignored folders a checkout rebuilds by itself: the only ignored content a holder may have and still be pruned. */
const REBUILDABLE = new Set(['node_modules', 'dist', 'build', 'target', '.turbo', '.next', '__pycache__']);

/**
 * Why a holder may not be pruned (anything but clean git worktrees in it), or null (#3909); archiving with "Delete branch
 * on archive" asks the same (worktreeArchive.cjs).
 * @param {{ path: string, worktrees: { path: string }[] }} h
 * @param {(args: string[], cwd: string) => Promise<{ ok: boolean, stdout: string }>} git
 * @param {string} MARKER the holder's marker file name
 */
async function whyKeptHolder(h, git, MARKER) {
  const managed = new Set(h.worktrees.map((w) => path.basename(w.path)));
  let children = [];
  try {
    children = fs.readdirSync(h.path).filter((name) => name !== MARKER);
  } catch (error) {
    noteIgnored('read a worktree holder folder', error, ['ENOENT', 'ENOTDIR']);
    return 'its folder could not be read';
  }
  if (children.some((name) => !managed.has(name) || !fs.existsSync(path.join(h.path, name, '.git'))))
    return 'it holds other files or folders';
  for (const w of h.worktrees) {
    const s = await git(['status', '--porcelain', '--ignored=matching'], w.path);
    if (!s.ok) return `unreadable status in ${path.basename(w.path)}`;
    const lines = s.stdout.split('\n').filter((l) => l.trim());
    if (lines.some((l) => !l.startsWith('!! '))) return `uncommitted changes in ${path.basename(w.path)}`;
    // git status skips ignored files; scratch, logs and local data there are gone for good once the checkout is removed
    if (lines.some((l) => !REBUILDABLE.has(path.basename(l.slice(3).replace(/\/$/, '')))))
      return `ignored files that are not rebuildable in ${path.basename(w.path)}`;
  }
  return null;
}

/**
 * @param {{ git: (args: string[], cwd: string) => Promise<{ ok: boolean, stdout: string }>, listWorktrees: (root: string) => any[],
 *   removeWorktree: (wt: any) => Promise<boolean>, marker: string, canonical: (p: string) => string }} d
 */
function createPruner(d) {
  const { git, listWorktrees, removeWorktree, marker: MARKER, canonical } = d;
  /**
   * Which units (managed holder folders: `path`, `createdAt`) to delete so at most `limit` remain: oldest first, never
   * one a chat is still using (`keep`: chat cwds, the unit itself or anything under it) and never one `dirty` says to keep.
   */
  function pruneCandidates(units, limit, keep, dirty) {
    return pastLimit(units, limit).filter((u) => !inUse(u, keep) && !dirty(u));
  }
  /** The units beyond the newest `limit` (a bad limit means 15, never below 1), oldest last. */
  const pastLimit = (units, limit) =>
    [...units].sort((a, b) => b.createdAt - a.createdAt).slice(Math.max(1, Math.floor(Number(limit) || 15)));
  /** Whether a chat works in the unit: its cwd is the unit's folder or under it. */
  const inUse = (u, keep) => {
    // the same folder under a symlink or another case (macOS) is the same folder
    const at = canonical(u.path);
    return keep.some((c) => {
      const cwd = canonical(c);
      return cwd === at || cwd.startsWith(at + path.sep);
    });
  };

  /** The managed worktrees of `list`, grouped by holder folder: a holder is one unit, however many folders it holds. */
  function holdersOf(list) {
    const byDir = new Map();
    for (const w of list) {
      const dir = path.dirname(w.path);
      const h = byDir.get(dir) ?? { path: dir, createdAt: w.createdAt, worktrees: [] };
      h.worktrees.push(w);
      byDir.set(dir, h);
    }
    return [...byDir.values()];
  }

  /**
   * Delete the oldest holders past `limit`. Only a holder of clean git worktrees nobody works in goes; one with any
   * other file or folder, a dirty or unreadable worktree, or a chat working in it (even from a sibling folder) is kept.
   * `log` gets one line for each holder pruned or kept back, with the reason (#3909).
   * @param {string} root
   * @param {number} limit
   * @param {string[]} [keep] chat cwds
   * @param {(line: string) => void} [log]
   * @returns {Promise<string[]>} the worktree paths removed
   */
  async function pruneWorktrees(root, limit, keep = [], log = () => undefined) {
    if (touchesRealRootUnderTest(root)) {
      log(`worktree prune of ${root} refused: a test must never prune the real worktree root`);
      return [];
    }
    const holders = holdersOf(listWorktrees(root));
    if (holders.length <= Math.max(1, Math.floor(Number(limit) || 15))) return [];
    const why = new Map();
    for (const h of holders) why.set(h.path, await whyKeptHolder(h, git, MARKER));
    const removed = [];
    for (const h of pastLimit(holders, limit)) {
      const reason = why.get(h.path) ?? (inUse(h, keep) ? 'a chat works in it' : null);
      if (reason) {
        log(`worktree holder ${h.path} kept: ${reason}`);
        continue;
      }
      let all = true;
      for (const w of h.worktrees)
        if (await removeWorktree(w)) removed.push(w.path);
        else all = false;
      log(
        all
          ? `worktree holder ${h.path} pruned: over the limit of ${limit}, clean and unused`
          : `worktree holder ${h.path} kept: git could not remove every worktree`,
      );
    }
    return removed;
  }

  return { pruneCandidates, pruneWorktrees };
}

module.exports = { createPruner, whyKeptHolder };
