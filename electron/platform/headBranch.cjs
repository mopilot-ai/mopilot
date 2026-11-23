// The branch a folder's Git checkout is on, read from its HEAD file without running git (a worktree's .git file is followed), and the project rows a phone lists with it; when @host-portable: loads in the Host process without Electron (host/boundary.json).
const fs = require('node:fs');
const path = require('node:path');

/** A read that fails (no folder, not a repository, unreadable) is no answer, not an error. */
const read = (/** @type {string} */ file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * The branch checked out at `dir`'s top level, or null: not a Git checkout, a detached HEAD, or anything unreadable.
 * Only the folder itself is looked at (a project is opened at its repository's root), so this never walks up.
 * @param {unknown} dir
 * @returns {string | null}
 */
function headBranch(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  const dotGit = path.join(dir, '.git');
  // a linked worktree or a submodule has a .git file naming its real git dir
  const pointer = read(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  const gitDir = pointer ? path.resolve(dir, pointer) : dotGit;
  const ref = read(path.join(gitDir, 'HEAD'))?.match(/^ref:\s*refs\/heads\/(.+?)\s*$/)?.[1];
  return ref || null;
}

/**
 * The projects as a phone lists them: id, name and the branch its folder is on now (null when unknown). The path stays
 * on the Mac.
 * @param {Array<{ id: string, name: string, path: string }>} projects
 */
const phoneProjects = (projects) => projects.map((p) => ({ id: p.id, name: p.name, branch: headBranch(p.path) }));

module.exports = { headBranch, phoneProjects };
