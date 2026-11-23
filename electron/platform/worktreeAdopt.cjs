// Adopting a git worktree another tool made (Conductor's, or the user's own) as a managed one, in place: its marker lives in the worktree's private git folder.
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * Not the holder marker MoPilot's own worktrees use: that one sits in the folder around the checkout, and the folder
 * around an adopted worktree is shared with its siblings (~/conductor/workspaces/<repo>/), so one marker there would
 * claim them all. This one is inside <repo>/.git/worktrees/<name>, which git keeps for exactly one worktree and removes with it.
 */
const ADOPT_MARKER = 'mopilot-worktree.json';

const GONE = ['ENOENT', 'ENOTDIR'];
/** Git's pointer files are one short line: anything larger is not one, and is not read. */
const MAX_POINTER_BYTES = 64 * 1024;

/**
 * The text of one of git's small files, or null when `file` is missing or is not a small regular file: a pipe, a device
 * or a link by that name is never opened (reading one would block or never end), and neither is a huge file.
 */
function readSmall(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= MAX_POINTER_BYTES ? fs.readFileSync(file, 'utf8') : null;
  } catch (error) {
    noteIgnored("read one of git's pointer files", error, GONE);
    return null;
  }
}

/** Whether `dir`'s .git is a file naming a git folder: what a linked worktree has, and a copy of one or a submodule too. */
const pointerOf = (dir) => /^gitdir: (.+)$/m.exec(readSmall(path.join(dir, '.git')) ?? '')?.[1].trim() ?? null;

const realpath = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch (error) {
    noteIgnored('resolve a worktree path', error, GONE);
    return null;
  }
};

/**
 * What git's own files say about the linked worktree whose top folder is `dir`: its private git folder
 * (<repo>/.git/worktrees/<name>) and the repository's (`common`); null for anything else. Read from the files, as git
 * left them now, so nothing recorded at adoption can go stale. Both directions must agree: the folder names its git
 * folder, and that git folder names this folder back, so a copy of a worktree (which still points at the original's
 * git folder) or a hand-made pointer at somebody else's repository is not taken for a worktree.
 */
function linked(dir) {
  const pointer = pointerOf(dir);
  if (!pointer) return null;
  const own = path.resolve(dir, pointer);
  // only a linked worktree's git folder has these: a submodule's (.git/modules/<name>) is a repository of its own
  const back = readSmall(path.join(own, 'gitdir'));
  const toCommon = readSmall(path.join(own, 'commondir'));
  if (back === null || toCommon === null) return null;
  const mine = realpath(path.join(dir, '.git'));
  if (!mine || realpath(path.resolve(own, back.trim())) !== mine) return null;
  const common = path.resolve(own, toCommon.trim());
  return fs.statSync(common, { throwIfNoEntry: false })?.isDirectory() ? { own, common } : null;
}

/** The branch a worktree has checked out now, from its HEAD file; null when detached or unreadable. */
function headBranch(own) {
  const ref = /^ref: refs\/heads\/(.+)$/m.exec(readSmall(path.join(own, 'HEAD')) ?? '');
  return ref ? ref[1].trim() : null;
}

/** The adoption marker in a worktree's private git folder, or null when there is none or it is not JSON. */
function readMarker(own) {
  try {
    return JSON.parse(readSmall(path.join(own, ADOPT_MARKER)) ?? 'null');
  } catch (error) {
    noteIgnored('parse a worktree adoption marker', error);
    return null;
  }
}

/**
 * The adopted worktree whose top folder is `dir`, or null. `repo` is the checkout the worktree belongs to and `branch`
 * the one it has checked out, both as they are now.
 * @param {string} dir
 * @returns {{ path: string, repo: string, branch: string | null, adopted: true, createdAt: number, sourceBranch?: string } | null}
 */
function adoptedInfo(dir) {
  const at = linked(dir);
  const m = at && readMarker(at.own);
  if (!at || !m || m.adopted !== true || path.basename(at.common) !== '.git') return null;
  return { path: dir, repo: path.dirname(at.common), branch: headBranch(at.own), adopted: true, createdAt: Number(m.createdAt) || 0 };
}

/**
 * Make the existing linked worktree at `dir` a managed one where it is: nothing is cloned, moved or checked out, and
 * its branch stays. Refused for anything that is not a linked worktree's top folder, and for a repository without a
 * checkout of its own (bare), which has no folder to be the project. One that is managed already is left as it is.
 * @param {string} dir
 * @param {{ managed: (dir: string) => { path: string, repo: string, branch: string | null } | null }} d `managed`: git.cjs's worktreeInfo
 * @returns {{ ok: true, adopted: boolean, path: string, repo: string, branch: string | null } | { ok: false, error: string }}
 */
function adopt(dir, { managed }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { ok: false, error: 'No folder to adopt' };
  const at = linked(dir);
  if (!at) return { ok: false, error: `${dir} is not a git worktree of another checkout` };
  // this very folder, not one around it: a worktree inside a managed one is its own checkout, and is adopted as such
  const known = managed(dir);
  if (known && known.path === dir) return { ok: true, adopted: false, path: dir, repo: known.repo, branch: known.branch };
  if (path.basename(at.common) !== '.git')
    return {
      ok: false,
      error: `The repository of ${dir} has no checkout of its own (it is bare), so there is no project folder to add it to`,
    };
  writeAtomic(path.join(at.own, ADOPT_MARKER), JSON.stringify({ adopted: true, createdAt: Date.now() }));
  return { ok: true, adopted: true, path: dir, repo: path.dirname(at.common), branch: headBranch(at.own) };
}

/**
 * The worktrees of the repository `cwd` is in that were adopted in place (Conductor workspaces brought over), as git
 * lists them now: one removed since is not there, and each has the branch it has checked out now. Null when git could
 * not say (not a repository, or git failed): that is not "none", and a caller must not drop a pick over it.
 * @param {string} cwd @param {(args: string[], cwd: string) => Promise<{ ok: boolean, stdout: string }>} git
 * @returns {Promise<{ path: string, name: string, branch: string | null }[] | null>}
 */
async function listAdopted(cwd, git) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const r = await git(['worktree', 'list', '--porcelain'], cwd);
  if (!r.ok) return null;
  return r.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .flatMap((line) => {
      const info = adoptedInfo(line.slice('worktree '.length));
      return info ? [{ path: info.path, name: path.basename(info.path), branch: info.branch }] : [];
    });
}

module.exports = { listAdopted, adopt, adoptedInfo, linked, headBranch, pointerOf, ADOPT_MARKER, MAX_POINTER_BYTES };
