// Managed worktrees and environment scripts, for chats on any harness (no Codex needed). @host-portable: loads in the Host process without Electron (host/boundary.json).
// A worktree lives at <root>/<id>/<repo-name>; <root>/<id>/.mopilot-worktree.json marks it as ours,
// so auto-delete never touches worktrees the official Codex app made under the same root.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('./pty.cjs');
const { parseGitPathLine } = require('./gitParse.cjs');
const { readJson, writeAtomic } = require('./fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { git } = require('./gitRun.cjs');
const { copyIgnored, copyIgnoredFrom } = require('./worktreeCopy.cjs');
const { createPruner } = require('./worktreePrune.cjs');
const { removeCheckout } = require('./worktreeRemoval.cjs');
const { touchesRealRootUnderTest } = require('./realWorktreeRoot.cjs');
const { worktreeStart, addArgs, restoreBranch, WORKTREE_KEY } = require('./worktreeSource.cjs');
const shellEnv = require('./env.cjs');
const { NOT_A_REPO, NO_COMMITS } = require('../../shared/worktreeSupport.mjs');
const {
  invalidBranch,
  hasCommitOf,
  defaultBranchOf,
  listBranches: listBranchesWith,
  switchBranch: switchBranchWith,
} = require('../../shared/gitBranchOps.mjs');
const { DEFAULT_BRANCH_PREFIX } = require('../../shared/branchPrefix.mjs');
const { envFor, originDefaultBranch } = require('./worktreeEnv.cjs');
const { createPorts } = require('./worktreePorts.cjs');
const envScripts = require('./envScripts.cjs');
const { adopt, adoptedInfo, listAdopted } = require('./worktreeAdopt.cjs');

const MARKER = '.mopilot-worktree.json';

const defaultRoot = (home = os.homedir()) => path.join(home, '.mopilot', 'worktrees');
const ROOT_NOT_FULL = 'The worktree root in Settings → Git must be a full path, like ~/worktrees';

/**
 * Where worktrees go, from Settings (typed by hand): empty is the default folder, `~` is the home folder, and a
 * relative path is null (resolved, it would land under wherever main happened to start).
 */
function rootOf(root, home = os.homedir()) {
  const r = typeof root === 'string' ? root.trim() : '';
  if (!r) return defaultRoot(home);
  const full = r === '~' ? home : /^~[\\/]/.test(r) ? path.join(home, r.slice(2)) : r;
  return path.isAbsolute(full) ? full : null;
}

/**
 * The Codex app's own worktree folders: ~/.codex/worktrees, which the app uses when opened from the Dock (it doesn't
 * get the shell's environment), and $CODEX_HOME/worktrees when the shell sets one. The app's startup cleanup
 * force-removes worktrees there, uncommitted changes and all, including ones it didn't make, so a MoPilot worktree
 * there can vanish under a chat still working in it.
 */
const codexWorktreeDirs = () => {
  const home = shellEnv.childEnv().CODEX_HOME;
  return [path.join(os.homedir(), '.codex', 'worktrees'), ...(home ? [path.join(home, 'worktrees')] : [])];
};
const CODEX_OWNED =
  "The Codex app deletes worktrees in its own worktree folder, even ones a chat is using. Choose another folder in Settings → Git, or leave it empty for MoPilot's own.";
const CODEX_DELETED = "This chat's worktree was in the Codex app's worktree folder, whose cleanup deleted it. Its branch is kept.";
/**
 * `p` as the file system names it, for comparing folders: symlinks resolved through its nearest existing folder, and
 * in one case on macOS and Windows, whose disks ignore it.
 */
function canonical(p, platform = process.platform) {
  let dir = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  const real = path.join(fs.realpathSync.native(dir), ...rest);
  return platform === 'darwin' || platform === 'win32' ? real.toLowerCase() : real;
}
/** The Codex app's worktree folder `p` is in (or is), as canonical(), or null. */
function codexWorktreesOf(p) {
  const at = canonical(p);
  for (const dir of codexWorktreeDirs().map((dir) => canonical(dir))) {
    const rel = path.relative(dir, at);
    if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return { dir, rel };
  }
  return null;
}
/** Whether `p` is a Codex app worktree folder or inside one. */
const inCodexWorktrees = (p) => codexWorktreesOf(p) !== null;

const readMarker = (dir) => readJson(path.join(dir, MARKER));

/** Beside the default worktree root, so every MoPilot build on this machine hands out blocks from one table. */
const ports = createPorts({ file: () => path.join(os.homedir(), '.mopilot', 'worktree-ports.json') });

const hasCommit = (repo, ref) => hasCommitOf(git, repo, ref);
const defaultBranch = (repo) => defaultBranchOf(git, repo);

// As Claude Code's desktop app does: one branch is fetched at most every 30 minutes per repo, waiting at most 10s.
const FETCH_FRESH_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const fetchedAt = new Map();
/** The fetch under way per branch: worktrees made side by side (Start all) share it rather than race on its ref. */
const fetching = new Map();

/** Update origin/<name> from origin, unless done lately; offline or slow, the last-fetched copy stays. */
function refreshBranch(repo, name) {
  const key = `${repo}\0${name}`;
  if (Date.now() - (fetchedAt.get(key) ?? -Infinity) < FETCH_FRESH_MS) return Promise.resolve();
  const running = fetching.get(key);
  if (running) return running;
  const run = (async () => {
    if (!(await git(['check-ref-format', `refs/heads/${name}`], repo)).ok) return;
    const r = await git(
      ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`],
      repo,
      FETCH_TIMEOUT_MS,
    );
    if (r.ok) fetchedAt.set(key, Date.now());
  })().finally(() => fetching.delete(key));
  fetching.set(key, run);
  return run;
}

/** Whether a branch's agent configuration (.claude, .mcp.json) is the same at two commits. */
const sameAgentConfig = async (repo, a, b) =>
  (
    await git(
      [
        '-c',
        'diff.relative=false',
        'diff',
        '--quiet',
        '--no-ext-diff',
        '--no-textconv',
        a,
        b,
        '--',
        ':(top,icase).claude',
        ':(top,icase).mcp.json',
      ],
      repo,
    )
  ).ok;

/** The branch picker's list for cwd's repo (shared/gitBranchOps.mjs, as a machine's Host reads it); null outside a repo. */
const listBranches = (cwd) => listBranchesWith(git, cwd);

/** Check out `branch` where a chat runs without a worktree (Claude Code's desktop app does the same); nothing to do when it is checked out. */
const switchBranch = (cwd, branch) => switchBranchWith(git, cwd, branch);

/** Random 4-hex worktree ids to try before giving up (65,536 in all; each one is taken by a folder or a branch). */
const MAX_ID_TRIES = 200;

/**
 * Create a worktree for `cwd`'s repo on a new, untracked branch <prefix><id> from worktreeBase (opts.branch: the picked
 * one), or on the existing branch opts.checkout (a pull request's, fetched first; opts.pullRequest for a fork's head); the
 * result keeps cwd's subfolder.
 */
async function worktreeAdd(cwd, opts = {}) {
  if (opts.branch != null && invalidBranch(opts.branch)) return { ok: false, error: `Invalid branch name "${opts.branch}".` };
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  const repo = parseGitPathLine(top.stdout);
  // unsupported: the folder can't hold a worktree at all, so a new chat starts in it instead
  if (!top.ok || !repo) return { ok: false, unsupported: true, error: NOT_A_REPO };
  // cwd's folder in the repository, as git sees it: the top level is a resolved path, while cwd may be a symlinked
  // spelling of it (/tmp is /private/tmp on macOS), so path.relative(repo, cwd) would climb out of the worktree
  const prefix = await git(['rev-parse', '--show-prefix'], cwd);
  const sub = prefix.ok ? parseGitPathLine(prefix.stdout).replace(/\/$/, '') : '';
  const base = rootOf(opts.root);
  if (!base) return { ok: false, error: ROOT_NOT_FULL };
  if (inCodexWorktrees(base)) return { ok: false, error: CODEX_OWNED };
  const branchPrefix = opts.prefix || DEFAULT_BRANCH_PREFIX;
  const start = await worktreeStart(repo, opts, {
    head: async () => worktreeInfo(cwd)?.sourceBranch ?? (await defaultBranch(repo)),
    defaultBranch,
    refreshBranch,
    hasCommit,
    git,
    sameAgentConfig,
  });
  if (!start.ok) return start;
  if (start.ref === 'HEAD' && !(await hasCommit(repo, 'HEAD'))) return { ok: false, unsupported: true, error: NO_COMMITS };
  // auto-delete keeps a removed worktree's branch, so its id stays taken in this repository (worktree add -b would
  // refuse it), and an id is reserved by making its folder, so another worktree (of any repository) can't get it too
  const heads = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repo);
  const branches = new Set((heads.stdout || '').split('\n').filter(Boolean));
  fs.mkdirSync(base, { recursive: true });
  let id = '';
  for (let tries = 0; !id; tries++) {
    if (tries >= MAX_ID_TRIES) return { ok: false, error: 'No free worktree name: delete some old worktrees or branches' };
    const next = Math.random().toString(16).slice(2, 6);
    if ([...branches].some((b) => b === `${branchPrefix}${next}` || b.endsWith(`/${next}`))) continue;
    try {
      fs.mkdirSync(path.join(base, next));
      id = next;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const dir = path.join(base, id, path.basename(repo));
  const branch = start.checkout?.branch ?? `${branchPrefix}${id}`;
  const r = await git(['worktree', 'add', ...addArgs(start, branch, dir)], repo);
  if (!r.ok) {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    return { ok: false, error: r.stderr.trim() };
  }
  // a branch named without the id (a pull request's): recorded on it so a restore after auto-delete finds it
  if (start.checkout) await git(['config', `branch.${branch}.${WORKTREE_KEY}`, id], repo);
  writeAtomic(
    path.join(path.dirname(dir), MARKER),
    JSON.stringify({ repo, branch, sourceBranch: start.sourceBranch, createdAt: Date.now() }),
  );
  // a worktree pinned to a commit (main repair) is unattended and set up from that commit alone: no local secrets
  const copy = opts.baseCommit === undefined ? { copy: await copyIgnored(repo, dir) } : {};
  return { ok: true, path: sub ? path.join(dir, sub) : dir, worktree: dir, branch, repo, ...copy };
}

/** The managed worktree a path is in ({path, repo, branch}; `adopted` for one made elsewhere and adopted in place), or null. */
function worktreeInfo(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  for (let d = p, parent = path.dirname(d); parent !== d; d = parent, parent = path.dirname(d)) {
    const adopted = adoptedInfo(d);
    if (adopted) return adopted;
    const m = readMarker(parent);
    if (m && typeof m.repo === 'string')
      return {
        path: d,
        repo: m.repo,
        branch: m.branch ?? null,
        ...(m.sourceBranch ? { sourceBranch: m.sourceBranch } : {}),
        createdAt: m.createdAt ?? 0,
      };
  }
  return null;
}

/**
 * What a script or terminal started in `cwd` gets when that is inside a managed worktree: its name, paths, default
 * branch and port block, as MOPILOT_* and CONDUCTOR_* (worktreeEnv.cjs). Elsewhere, each of them as null: not set.
 */
function worktreeEnv(cwd) {
  const info = worktreeInfo(cwd);
  return info ? envFor({ ...info, defaultBranch: originDefaultBranch(info.repo) }, ports.portFor(canonical(info.path))) : envFor(null);
}
pty.setCwdEnv(worktreeEnv);

/**
 * Worktrees under root (<root>/<id>/<repo>), newest first. Only managed ones unless `all`, which
 * also lists those older builds or the official app made there (repo null).
 */
function listWorktrees(root, all = false) {
  const out = [];
  let ids = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const e of ids) {
    const holder = path.join(root, e.name);
    const m = readMarker(holder);
    if (!m && !all) continue;
    let names = [];
    try {
      names = fs.readdirSync(holder, { withFileTypes: true }).filter((x) => x.isDirectory());
    } catch (error) {
      // no worktree holder folder here (ENOENT, or a file: ENOTDIR): nothing to list
      noteIgnored('list managed worktrees', error, ['ENOENT', 'ENOTDIR']);
    }
    for (const n of names) {
      const p = path.join(holder, n.name);
      if (!fs.existsSync(path.join(p, '.git'))) continue; // a folder beside the checkout is no worktree (#3909)
      if (m) out.push({ path: p, repo: m.repo, branch: m.branch ?? null, createdAt: m.createdAt ?? 0 });
      else out.push({ path: p, repo: null, branch: null, createdAt: fs.statSync(p).mtimeMs });
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Every worktree under root, with the branch each has checked out. */
async function listAll(root) {
  const list = listWorktrees(root, true);
  for (const w of list) {
    const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], w.path);
    if (b.ok) w.branch = b.stdout.trim();
  }
  return list;
}

/**
 * Remove a worktree (its branch stays), finishing one a held folder stopped half way (worktreeRemoval.cjs); one adopted in place is refused. The holder
 * folder goes only when nothing else is in it: the marker is dropped and the folder removed if empty, so nothing put beside the checkout is deleted (#3909).
 */
async function removeWorktree(wt, { io = fs.promises } = {}) {
  // an adopted worktree was made by another tool or by hand: it is used here, never removed from here
  if (touchesRealRootUnderTest(wt.path) || adoptedInfo(wt.path)) return false;
  const r = await removeCheckout(wt.path, () => git(['worktree', 'remove', '--force', wt.path], wt.repo), io);
  if (!r.ok && fs.existsSync(wt.path)) return false;
  const holder = path.dirname(wt.path);
  let others = [];
  try {
    others = fs.readdirSync(holder).filter((n) => n !== MARKER);
  } catch (error) {
    noteIgnored('read a worktree holder folder', error, ['ENOENT', 'ENOTDIR']);
  }
  if (!others.length) {
    fs.rmSync(path.join(holder, MARKER), { force: true });
    try {
      fs.rmdirSync(holder);
    } catch (error) {
      noteIgnored('remove an empty worktree holder folder', error, ['ENOENT', 'ENOTEMPTY']);
    }
  }
  await git(['worktree', 'prune'], wt.repo);
  ports.release(canonical(wt.path));
  return true;
}

/**
 * Bring back a managed worktree that was deleted (auto-delete keeps the branch): `cwd` is where a chat ran,
 * <root>/<id>/<repo-name>[/sub]; the branch is <prefix><id> in `repo`, else in the project the holder's marker names
 * (`prefix`: the branch prefix in Settings, which need not end in a slash), else mopilot/<id> or one ending in /<id>.
 * Nothing to do when it exists.
 * Returns {ok, restored, branch, worktree} or {ok: false, error}.
 */
async function worktreeRestore(cwd, root, repo, prefix = null) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { ok: false, error: 'No folder to restore' };
  if (fs.existsSync(cwd)) return { ok: true, restored: false };
  const base = rootOf(root);
  if (!base) return { ok: false, error: ROOT_NOT_FULL };
  // brought back there, the Codex app would delete it again
  if (inCodexWorktrees(base)) return { ok: false, error: CODEX_OWNED };
  // one of ours from when worktrees went there (the Codex app's cleanup removed it): say so rather than nothing; the
  // app's own worktrees (no marker) aren't ours to explain
  const codex = codexWorktreesOf(cwd);
  if (codex && readMarker(path.join(codex.dir, codex.rel.split(path.sep)[0]))) return { ok: false, error: CODEX_DELETED };
  const rel = path.relative(base, cwd);
  const [id, name, ...rest] = rel.split(path.sep);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !id || !name) return { ok: false, error: 'Not a MoPilot worktree' };
  // a chat that doesn't record its project (a Claude Code chat, one from before worktreeOf): the holder's marker names it
  if (typeof repo !== 'string' || !fs.existsSync(repo)) repo = readMarker(path.join(base, id))?.repo;
  if (typeof repo !== 'string' || !fs.existsSync(repo)) return { ok: false, error: 'The project folder is gone' };
  const owner = readMarker(path.join(base, id));
  const found = await restoreBranch(repo, id, prefix || DEFAULT_BRANCH_PREFIX, owner, git);
  if (!found.ok) return found;
  const { branch } = found;
  const dir = path.join(base, id, name);
  // the id went to another repository's worktree since: restoring here would write over its marker, and pruning
  // either one would delete the other with its holder folder
  if (owner && owner.repo !== repo) return { ok: false, error: `Another worktree uses …/${id} now` };
  await git(['worktree', 'prune'], repo);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(['worktree', 'add', dir, branch], repo);
  if (!r.ok) return { ok: false, error: r.stderr.trim() };
  writeAtomic(path.join(path.dirname(dir), MARKER), JSON.stringify({ repo, branch, createdAt: Date.now() }));
  return { ok: true, restored: true, branch, worktree: dir, path: path.join(dir, ...rest), repo, copy: await copyIgnoredFrom(repo, dir) };
}

const envFile = (root) => path.join(root, '.codex', 'environments', 'environment.toml');

/**
 * The working directory of every chat that is not archived, on any harness, from main's own records (set once the chats
 * exist). A prune adds them to the window's list, so it never depends on the window alone (#3909).
 * @type {(() => Promise<string[] | null>) | null}
 */
let chatFolders = null;
const setChatFolders = (fn) => (chatFolders = fn);

function register(ipcMain) {
  ipcMain.handle('git:worktreeAdd', (_e, cwd, opts) => worktreeAdd(cwd, opts || {}));
  ipcMain.handle('git:branches', (_e, cwd) => listBranches(cwd));
  ipcMain.handle('git:switchBranch', (_e, cwd, branch) => switchBranch(cwd, branch));
  ipcMain.handle('git:worktreeInfo', (_e, p) => worktreeInfo(p));
  // a root that isn't a full path has no worktrees of ours to list or prune
  ipcMain.handle('git:worktreeList', async (_e, root) => (rootOf(root) ? listAll(rootOf(root)) : []));
  ipcMain.handle('git:worktreeAdopted', (_e, cwd) => listAdopted(cwd, git));
  ipcMain.handle('git:worktreeRestore', (_e, cwd, root, repo, prefix) => worktreeRestore(cwd, root, repo, prefix));
  ipcMain.handle('git:worktreePrune', async (_e, root, limit, keep) => {
    const base = rootOf(root);
    if (!base) return [];
    const mine = Array.isArray(keep) ? keep.map(String) : [];
    /** @type {string[] | null | undefined} */
    let known = null;
    try {
      known = await chatFolders?.();
    } catch (error) {
      noteIgnored('list every chat folder before pruning worktrees', error);
    }
    // without main's complete list (not set, unreadable, or incomplete) a chat it can't see might work in a worktree
    if (!known) return [];
    return pruneWorktrees(base, limit, [...mine, ...known], (line) => console.warn(line));
  });
  envScripts.register(ipcMain);
  // A project's environment.toml (the only file this writes).
  ipcMain.handle('env:write', (_e, root, text) => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof text !== 'string') return { ok: false, error: 'invalid' };
    try {
      writeAtomic(envFile(root), text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

const { pruneCandidates, pruneWorktrees } = createPruner({ git, listWorktrees, removeWorktree, marker: MARKER, canonical });

module.exports = {
  setChatFolders,
  register,
  worktreeAdd,
  listBranches,
  switchBranch,
  worktreeRestore,
  worktreeInfo,
  worktreeEnv,
  worktreeAdopt: (dir) => adopt(dir, { managed: worktreeInfo }),
  listWorktrees,
  removeWorktree,
  pruneWorktrees,
  pruneCandidates,
  runScript: envScripts.runScript,
  defaultRoot,
  rootOf,
  inCodexWorktrees,
  canonical,
  CODEX_OWNED,
  CODEX_DELETED,
  MARKER,
};
