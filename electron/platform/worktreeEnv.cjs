// The variables a script or terminal gets inside a managed worktree: MOPILOT_* and, for scripts written for Conductor, the same values as CONDUCTOR_*.
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/** Each worktree owns this many consecutive ports, starting at its PORT variable. */
const PORTS_PER_WORKTREE = 10;
const NAMES = ['WORKSPACE_NAME', 'WORKSPACE_ID', 'WORKSPACE_PATH', 'ROOT_PATH', 'DEFAULT_BRANCH', 'PORT', 'IS_LOCAL'];

/**
 * Every variable for the managed worktree `info` (git.cjs's worktreeInfo). One whose value is not known (no port block
 * free, no default or starting branch), and every one outside a worktree, is null: the pty layer then removes it, so a
 * value inherited from the terminal the app was started in (a worktree's own, or Conductor's) never shows up as this
 * folder's.
 * @param {{ path: string, repo: string, sourceBranch?: string, defaultBranch?: string, adopted?: boolean } | null} info
 * @param {number | null} [port] the first port of the worktree's block
 * @returns {Record<string, string | null>}
 */
function envFor(info, port = null) {
  /** @type {Record<string, string | null>} */
  const out = {};
  if (!info) {
    for (const k of NAMES) out[`MOPILOT_${k}`] = out[`CONDUCTOR_${k}`] = null;
    return out;
  }
  // <root>/<id>/<repo name>: the holder folder's name is the worktree's own name; an adopted one is named by its folder
  const name = path.basename(info.adopted ? info.path : path.dirname(info.path));
  const values = {
    WORKSPACE_NAME: name,
    WORKSPACE_ID: name,
    WORKSPACE_PATH: info.path,
    ROOT_PATH: info.repo,
    DEFAULT_BRANCH: info.defaultBranch || info.sourceBranch,
    PORT: port,
    IS_LOCAL: '1',
  };
  for (const k of NAMES) {
    const v = values[k];
    out[`MOPILOT_${k}`] = out[`CONDUCTOR_${k}`] = v == null || v === '' ? null : String(v);
  }
  return out;
}

/**
 * origin's default branch as the repository's own files record it (refs/remotes/origin/HEAD), read without starting git
 * so a terminal opens no slower; '' when origin has none set. `repo` may itself be a linked worktree, whose `.git` is a
 * file naming its git folder. A repository that keeps its refs elsewhere (reftable) reads as none set.
 * @param {string} repo the checkout's top folder
 */
function originDefaultBranch(repo) {
  try {
    let dir = path.join(repo, '.git');
    if (!fs.statSync(dir).isDirectory()) {
      const own = /^gitdir: (.+)$/m.exec(fs.readFileSync(dir, 'utf8'));
      if (!own) return '';
      dir = path.resolve(repo, own[1].trim());
      // a linked worktree's git folder names the repository's; a submodule's or a separate git folder is the repository's
      const common = path.join(dir, 'commondir');
      if (fs.existsSync(common)) dir = path.resolve(dir, fs.readFileSync(common, 'utf8').trim());
    }
    const head = /^ref: refs\/remotes\/origin\/(.+)$/m.exec(fs.readFileSync(path.join(dir, 'refs', 'remotes', 'origin', 'HEAD'), 'utf8'));
    return head ? head[1].trim() : '';
  } catch (error) {
    // no origin, no default set on it, or no repository left: the variable follows the worktree's starting branch
    noteIgnored("read origin's default branch for a worktree's variables", error, ['ENOENT', 'ENOTDIR']);
    return '';
  }
}

module.exports = { envFor, originDefaultBranch, PORTS_PER_WORKTREE };
