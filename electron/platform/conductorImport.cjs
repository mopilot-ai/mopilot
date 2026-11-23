// What a Conductor user has on this machine, and bringing it in: its repositories and workspaces (git worktrees) are found from the folders and git's own files, added as projects and adopted in place.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { linked, headBranch, adoptedInfo, pointerOf } = require('./worktreeAdopt.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { userError } = require('../../shared/userError.mjs');

/** How many folders one discovery looks at in all, and how many entries of one folder it reads to find them. */
const MAX_CANDIDATES = 2000;
const MAX_ENTRIES = 10_000;

/**
 * Conductor's workspaces on this machine, grouped by the repository each belongs to. Only git is trusted: a folder
 * counts when git's files say, in both directions, that it is a linked worktree of a repository with its own checkout,
 * wherever Conductor's own records (which are not read) say it is. Nothing is written and no process is started.
 *
 * Looked in: ~/conductor/workspaces/<repo>/<workspace> (the current layout) and <project>/.conductor/<workspace> for
 * each known project (the older one). At most MAX_CANDIDATES folders are looked at; `truncated` says more were there.
 * @param {{ home?: string, projects?: string[] }} [opts] `projects`: the folders of the projects MoPilot already has
 * @returns {{ repos: { repo: string, name: string, workspaces: { path: string, name: string, branch: string | null, adopted: boolean }[] }[],
 *   skipped: { path: string, reason: string }[], truncated: boolean }}
 */
function discover(opts = {}) {
  const home = typeof opts.home === 'string' ? opts.home : os.homedir();
  const projects = Array.isArray(opts.projects) ? opts.projects : [];
  let budget = MAX_CANDIDATES;
  let truncated = false;

  /** The folders directly in `dir` (not files, not links), by name, within what is left of the budget. */
  const foldersIn = (dir) => {
    const names = [];
    try {
      const handle = fs.opendirSync(dir);
      try {
        let read = 0;
        for (let e = handle.readSync(); e; e = handle.readSync()) {
          if (++read > MAX_ENTRIES || names.length >= budget) {
            truncated = true;
            break;
          }
          if (e.isDirectory()) names.push(e.name);
        }
      } finally {
        handle.closeSync();
      }
    } catch (error) {
      noteIgnored('list a Conductor folder', error, ['ENOENT', 'ENOTDIR']);
    }
    return names.sort().map((name) => path.join(dir, name));
  };

  const candidates = [];
  const add = (dir) => {
    const found = foldersIn(dir);
    budget -= found.length;
    candidates.push(...found);
  };
  for (const repoDir of foldersIn(path.join(home, 'conductor', 'workspaces'))) add(repoDir);
  for (const project of projects) if (typeof project === 'string' && path.isAbsolute(project)) add(path.join(project, '.conductor'));

  /** @type {Map<string, { repo: string, name: string, workspaces: any[] }>} */
  const byRepo = new Map();
  const skipped = [];
  const seen = new Set();
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const at = linked(dir);
    if (!at) {
      // a pointer git does not honour: the repository is gone or moved, the worktree was pruned, or this is a copy of one
      skipped.push({ path: dir, reason: pointerOf(dir) ? 'git does not list this folder as a worktree' : 'not a git worktree' });
      continue;
    }
    const repo = path.dirname(at.common);
    if (path.basename(at.common) !== '.git') {
      skipped.push({ path: dir, reason: 'its repository has no checkout of its own' });
      continue;
    }
    const group = byRepo.get(repo) ?? { repo, name: path.basename(repo), workspaces: [] };
    group.workspaces.push({ path: dir, name: path.basename(dir), branch: headBranch(at.own), adopted: !!adoptedInfo(dir) });
    byRepo.set(repo, group);
  }
  const repos = [...byRepo.values()].sort((a, b) => Number(a.repo > b.repo) - Number(a.repo < b.repo));
  return { repos, skipped, truncated };
}

/** `p` with links resolved, or as given when it is not there to resolve. */
function realOf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (error) {
    noteIgnored("resolve a project's folder", error, ['ENOENT', 'ENOTDIR']);
    return p;
  }
}

/**
 * Bring what discover() found into MoPilot: each repository becomes a project (one that is a project already is kept as
 * it is), and each of its workspaces is adopted where it is, on its own branch. Nothing is cloned, moved or removed,
 * and running it again changes nothing. One repository or workspace that fails is reported and does not stop the rest.
 * @param {ReturnType<typeof discover>} found
 * @param {{ store: { list: () => { projects: { id: string, path: string }[] }, add: (opts: { path: string, name: string }) => string },
 *   adopt: (dir: string) => { ok: true, adopted: boolean, branch: string | null } | { ok: false, error: string },
 *   only?: unknown }} d `only`: the repositories to import, as discover() names them; all of them when left out
 */
function importFound(found, { store, adopt, only }) {
  // a selection that is not a list selects nothing: only leaving it out means everything
  const pick = only == null ? null : new Set(Array.isArray(only) ? only : []);
  // git names a repository by its real path; a project added through a link to it is that same project
  const known = new Map();
  for (const p of store.list().projects) known.set(realOf(p.path), p.id);
  const repos = [];
  for (const r of found.repos) {
    if (pick && !pick.has(r.repo)) continue;
    let projectId = known.get(realOf(r.repo));
    const added = projectId === undefined;
    try {
      projectId ??= store.add({ path: r.repo, name: r.name });
    } catch (error) {
      repos.push({ repo: r.repo, name: r.name, error: userError(error), workspaces: [] });
      continue;
    }
    const workspaces = r.workspaces.map((w) => {
      const base = { path: w.path, name: w.name };
      try {
        const a = adopt(w.path);
        return a.ok
          ? { ...base, branch: a.branch, status: a.adopted ? 'adopted' : 'already' }
          : { ...base, status: 'failed', error: a.error };
      } catch (error) {
        return { ...base, status: 'failed', error: userError(error) };
      }
    });
    repos.push({ repo: r.repo, name: r.name, projectId, added, workspaces });
  }
  return { repos, skipped: found.skipped, truncated: found.truncated };
}

/**
 * IPC for the import, beside the project list's own (projects.cjs registers it with its store). The window never
 * names a folder to adopt: an import discovers again here and takes only what that finds.
 * @param ipcMain
 * @param store ProjectsStore
 */
function register(ipcMain, store) {
  // required here: git.cjs loads the pty layer, which a process that only lists projects has no use for
  const adopt = (dir) => require('./git.cjs').worktreeAdopt(dir);
  const find = () => discover({ projects: store.list().projects.map((p) => p.path) });
  ipcMain.handle('conductor:discover', () => find());
  ipcMain.handle('conductor:import', (_e, only) => importFound(find(), { store, adopt, only }));
}

module.exports = { discover, importFound, register, MAX_CANDIDATES };
