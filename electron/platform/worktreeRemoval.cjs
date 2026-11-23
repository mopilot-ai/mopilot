// Finishes a `git worktree remove` that deleted the admin entry but not the whole checkout (a folder Windows still holds), for managed worktrees (platform/git.cjs) and cancelled starts (platform/discardWorktree.cjs).
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/**
 * fs.rm's retries of a folder Windows still holds (EBUSY, EPERM), each 100 ms longer than the last: about 15 s in all,
 * as long as tests/e2e/fixtures/worktreeDelete.ts waits for the same hold.
 */
const HELD = { maxRetries: 17, retryDelay: 100 };

/** Whether `p` is known to be gone: any other error than ENOENT (no permission) leaves it unknown. */
const gone = (p, io) =>
  io.stat(p).then(
    () => false,
    (error) => error.code === 'ENOENT',
  );

/** Whether `a` and `b` name the same file, through symlinks and another case (stat's device and file ids). */
async function sameFile(a, b, io) {
  const [x, y] = await Promise.all([io.stat(a, { bigint: true }), io.stat(b, { bigint: true })]);
  return x.dev === y.dev && x.ino === y.ino;
}

/**
 * The linked worktree checked out at `dir`, as git records it: `admin`, the folder (<repo>/.git/worktrees/<id>) its .git
 * file names, whose own gitdir file names that .git file back, and `real`, `dir` with symlinks resolved, which is the
 * folder git deletes. Null for anything else, a moved or copied checkout among them: their admin entry is another
 * folder's, which may go for reasons of its own (a prune) while git refuses this one.
 */
async function worktreeAt(dir, io) {
  const dotGit = path.join(dir, '.git');
  let text = '';
  try {
    text = await io.readFile(dotGit, 'utf8');
  } catch (error) {
    // no .git file, so no linked worktree (EISDIR: a repository's own checkout)
    noteIgnored("read a worktree's .git file before removing it", error, ['ENOENT', 'ENOTDIR', 'EISDIR']);
    return null;
  }
  const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text);
  if (!m) return null;
  const admin = path.resolve(dir, m[1]);
  try {
    // git writes it absolute, or relative to the admin folder (worktree.useRelativePaths)
    const back = (await io.readFile(path.join(admin, 'gitdir'), 'utf8')).trim();
    return (await sameFile(path.resolve(admin, back), dotGit, io)) ? { admin, real: await io.realpath(dir) } : null;
  } catch (error) {
    // no admin entry, or one naming a folder that is gone: a checkout git no longer knows (`git worktree repair`)
    noteIgnored("read a worktree's admin entry before removing it", error, ['ENOENT', 'ENOTDIR']);
    return null;
  }
}

/**
 * Runs `remove` (`git worktree remove` of the checkout at `dir`) and returns its outcome, `ok` once `dir` is gone. git
 * deletes the checkout and then its admin entry even when the delete failed, as it does on Windows while a process that
 * just exited (a cleanup script's terminal) still holds the folder; what is left has no working .git, and no prune finds
 * it again. So when the command fails and the admin entry of the worktree at `dir` before it ran is gone, the rest of
 * the folder is deleted, waiting out the hold. A command that failed before deleting anything (local changes, a locked
 * worktree, a folder that is no linked worktree) leaves `dir` as it is.
 * @template {{ ok: boolean }} R
 * @param {string} dir
 * @param {() => Promise<R>} remove
 * @param {Pick<typeof import('node:fs/promises'), 'readFile' | 'stat' | 'realpath' | 'rm'>} io
 * @returns {Promise<R>}
 */
async function removeCheckout(dir, remove, io) {
  const at = await worktreeAt(dir, io);
  const result = await remove();
  if (result.ok || !at || !(await gone(at.admin, io))) return result;
  try {
    await io.rm(at.real, { recursive: true, force: true, ...HELD });
    return { ...result, ok: true };
  } catch (error) {
    noteIgnored('delete the rest of a worktree git dropped', error);
    return result;
  }
}

module.exports = { removeCheckout };
