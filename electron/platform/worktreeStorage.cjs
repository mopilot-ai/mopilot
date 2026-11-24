// What managed worktrees (<root>/<id>/<repo>, platform/git.cjs) cost on disk and which of them may be removed, for the
// host tools (get_storage_usage, clean_up_worktrees, discard_kept_worktree) on every harness. A worktree is in use while
// a chat that is not archived works inside it, and one with uncommitted changes is removed only when the caller says so
// (the tools ask the user first). Both are read again right before each removal: a chat can start in a worktree, or a
// file change in it, while a card waits.
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/** Entries counted per worktree before its size is reported as "at least"; a runaway tree can't stall the scan. */
const MAX_ENTRIES = 400_000;

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order of the results. */
async function mapLimit(/** @type {any[]} */ items, /** @type {number} */ limit, /** @type {(item: any) => Promise<any>} */ fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The bytes under `dir` (links counted as themselves, never followed), and whether the walk stopped at the entry cap. */
async function dirSize(/** @type {string} */ dir, max = MAX_ENTRIES) {
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const here = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = await fs.promises.readdir(here, { withFileTypes: true });
    } catch {
      // a folder that vanished or can't be read counts as empty
      continue;
    }
    for (const e of entries) {
      if (++seen > max) return { bytes, truncated: true };
      const full = path.join(here, e.name);
      if (e.isDirectory()) stack.push(full);
      else
        bytes += await fs.promises.lstat(full).then(
          (s) => s.size,
          () => 0,
        );
    }
  }
  return { bytes, truncated: false };
}

/**
 * @param {object} d
 * @param {() => string | null} d.root the managed worktrees' folder (Settings → Git)
 * @param {(root: string) => { path: string, repo: string | null, branch: string | null, createdAt: number }[]} d.list the managed worktrees under it
 * @param {(wt: { path: string, repo: string }) => Promise<boolean>} d.remove removes one (its branch stays)
 * @param {(args: string[], cwd: string) => Promise<{ ok: boolean, stdout: string }>} d.git
 * @param {() => Promise<{ chatId: string, cwd: string | null, archived: boolean }[]>} d.chatFolders every chat's working directory
 * @param {(p: string) => string} d.canonical a path as the file system names it, for comparing
 * @param {(p: string) => Promise<{ bytes: number, truncated: boolean }>} [d.sizeOf]
 * @param {(p: string) => Promise<number | undefined>} [d.freeBytes] free space of the volume holding a path
 * @param {() => number} [d.now]
 */
function createWorktreeStorage(d) {
  const sizeOf = d.sizeOf ?? dirSize;
  const now = d.now ?? Date.now;
  /** @type {{ at: number, value: any } | null} */
  let cached = null;

  const inside = (/** @type {string} */ dir, /** @type {string} */ p) => {
    const rel = path.relative(d.canonical(dir), d.canonical(p));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  /** The chats working inside each of `worktrees` now (archived chats don't hold one: it comes back from its branch). */
  const holders = async (/** @type {{ path: string }[]} */ worktrees) => {
    const chats = (await d.chatFolders()).filter((c) => !c.archived && c.cwd);
    return worktrees.map((wt) => chats.filter((c) => inside(wt.path, /** @type {string} */ (c.cwd))).map((c) => c.chatId));
  };
  /** Whether a worktree has uncommitted changes; one git can't read counts as having some. */
  const uncommitted = async (/** @type {{ path: string }} */ wt) => {
    const s = await d.git(['status', '--porcelain'], wt.path);
    return !s.ok || !!s.stdout.trim();
  };

  /** Every managed worktree with its size, whether it has uncommitted changes, and the chats working in it. */
  async function scan() {
    const root = d.root();
    const list = root ? d.list(root) : [];
    const used = await holders(list);
    const rows = await mapLimit(list, 4, async (wt) => {
      const [size, dirty] = await Promise.all([sizeOf(wt.path), uncommitted(wt)]);
      return { ...wt, bytes: size.bytes, truncated: size.truncated, uncommitted: dirty };
    });
    return rows.map((r, i) => ({ ...r, usedBy: used[i] }));
  }

  return {
    scan,
    /** A measurement under a minute old unless `refresh`. */
    async usage(refresh = false) {
      if (!refresh && cached && now() - cached.at < 60_000) return cached.value;
      const root = d.root();
      const worktrees = await scan();
      let free;
      if (root && d.freeBytes) {
        try {
          free = await d.freeBytes(root);
        } catch (error) {
          // the folder or its volume can't be read: the report leaves the free space out
          noteIgnored('read the free space of the worktree folder', error);
        }
      }
      const value = { worktrees, free };
      cached = { at: now(), value };
      return value;
    },
    holders,
    /**
     * Removes `wt` unless a chat works in it now, or it has uncommitted changes and `includeUncommitted` is not set.
     * @returns {Promise<'removed' | 'in_use' | 'uncommitted' | 'gone' | 'failed'>}
     */
    async removeIfSafe(
      /** @type {any} */ wt,
      /** @type {{ includeUncommitted: boolean, usedBy: string[] }} */ { includeUncommitted, usedBy },
    ) {
      cached = null;
      if (usedBy.length) return 'in_use';
      if (!fs.existsSync(wt.path)) return 'gone';
      if (!includeUncommitted && (await uncommitted(wt))) return 'uncommitted';
      return (await d.remove(wt)) ? 'removed' : 'failed';
    },
    /** The managed worktree at `p`, as listed now, or null. */
    find(/** @type {string} */ p) {
      const root = d.root();
      return (root ? d.list(root) : []).find((wt) => d.canonical(wt.path) === d.canonical(p)) ?? null;
    },
    uncommitted,
  };
}

module.exports = { createWorktreeStorage, dirSize, mapLimit };
