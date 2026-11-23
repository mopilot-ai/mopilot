// The Changes pane's commit, with the git runner and the base environment given: every uncommitted change, or only the ticked files, built in an index of its own so the repository's index changes only once the commit is made. This Mac (commitFiles.cjs) and a machine's Host (host/src/hostWrite.mjs) both run it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UNMERGED_ARGS, unmergedPaths, conflictsSentence } = require('../../shared/gitUnmerged.mjs');

/** @typedef {(args: string[], cwd: string, timeout?: number, env?: NodeJS.ProcessEnv) => Promise<{ ok: boolean, stdout: string, stderr: string }>} Git */
/** @typedef {{ path: string, oldPath?: string, isCopy?: boolean, isDeleted?: boolean }} Picked */
/** @typedef {{ ok: boolean, stdout: string, stderr: string, refused?: true, warning?: string }} Result `refused`: stderr is a sentence for the user; `warning`: committed, with this to tell them */

const literal = (/** @type {string} */ p) => `:(literal)${p}`;
const refused = (/** @type {string} */ stderr) => ({ ok: false, stdout: '', stderr, refused: /** @type {const} */ (true) });
/** What git keeps while a merge, cherry-pick, revert or rebase waits to be committed: such a commit takes every change. */
const UNDER_WAY = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply'];

/**
 * Why only some files can't be committed now, or null: an operation under way, or a file with unresolved conflicts
 * (git refuses such a commit, but an index of its own has none to refuse it for).
 * @param {string} root @param {Git} git
 */
async function underWay(root, git) {
  const paths = await git(['rev-parse', '--path-format=absolute', ...UNDER_WAY.flatMap((p) => ['--git-path', p])], root);
  if (!paths.ok || paths.stdout.split('\n').some((p) => p && fs.existsSync(p)))
    return 'Finish or abort the merge, rebase, cherry-pick or revert under way before committing only some files.';
  const conflicts = await git(UNMERGED_ARGS, root);
  if (!conflicts.ok) return 'Resolve the conflicts first, then commit.';
  // any conflict refuses, whatever files are ticked: the commit's own index would take a conflicted file's markers as they are
  const unmerged = unmergedPaths(conflicts.stdout);
  return unmerged.length ? `${conflictsSentence(unmerged.length)}.` : null;
}
/** A commit runs hooks, which may take a while (a formatter, tests). */
const COMMIT_MS = 10 * 60_000;

const validFile = (/** @type {any} */ f) =>
  f &&
  typeof f.path === 'string' &&
  f.path.length > 0 &&
  !path.isAbsolute(f.path) &&
  (f.oldPath === undefined || f.oldPath === null || typeof f.oldPath === 'string');

/**
 * Commit in `root` (the repository root, which `files`' paths are relative to) with `message`: every change when
 * `files` is null, else only those files. Only those files' entries in the index are touched, and only once the commit
 * is made: a commit that fails (a hook, signing, a lock) leaves the index as it was, staged hunks too.
 * @param {unknown} root @param {unknown} message @param {unknown} files
 * @param {{ git: Git, baseEnv: () => NodeJS.ProcessEnv, folderOnly?: boolean }} deps the runner, the environment the commit's own index file is added to, and whether `root` is a folder inside its repository whose own paths only are committed (what else is staged stays staged)
 * @returns {Promise<Result>}
 */
async function commitWith(root, message, files, { git, baseEnv, folderOnly = false }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof message !== 'string' || !message.trim())
    return refused('Invalid commit request.');
  if (files === null) {
    // `git add -A` would stage the conflict markers as resolved: a conflicted file is resolved first (a merge under way with none is committable)
    const unmerged = await git(UNMERGED_ARGS, root);
    if (!unmerged.ok) return refused('Could not check for unresolved conflicts. Try again.');
    const conflicted = unmergedPaths(unmerged.stdout);
    if (conflicted.length) return refused(`${conflictsSentence(conflicted.length)}.`);
    // `.` keeps a commit from a folder inside a repository to that folder's own changes; at the repository's root it is every change
    const add = await git(['add', '-A', '--', '.'], root);
    return add.ok ? git(['commit', '-m', message, ...(folderOnly ? ['--', '.'] : [])], root, COMMIT_MS) : add;
  }
  if (!Array.isArray(files) || !files.every(validFile)) return refused('Invalid commit request.');
  // a path that is gone (a deleted file, a rename's old path) is taken out of the commit's index; the rest is added
  const gone = new Set(files.flatMap((f) => (f.isDeleted ? [f.path] : f.oldPath && f.oldPath !== f.path && !f.isCopy ? [f.oldPath] : [])));
  const present = new Set(files.filter((f) => !f.isDeleted).map((f) => f.path));
  if (!gone.size && !present.size) return refused('No files are selected to commit.');
  const stop = await underWay(root, git);
  if (stop) return refused(stop);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-commit-'));
  const env = { ...baseEnv(), GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    const head = await git(['rev-parse', '-q', '--verify', 'HEAD'], root);
    const before = head.ok ? head.stdout.trim() : null;
    // the commit's index: HEAD as it is, with the ticked files as they are on disk. It starts from a copy of the
    // repository's own, whose file stats spare git from reading every tracked file again; a one-tree read-tree keeps
    // the stats of entries that match HEAD and drops every staged change
    const source = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], root)).stdout.trim();
    let base = { ok: false, stdout: '', stderr: '' };
    if (before && source && fs.existsSync(source)) {
      fs.copyFileSync(source, env.GIT_INDEX_FILE);
      base = await git(['read-tree', '-m', 'HEAD'], root, 0, env);
    }
    if (!base.ok) {
      fs.rmSync(env.GIT_INDEX_FILE, { force: true });
      base = await git(before ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], root, 0, env);
    }
    if (!base.ok) return base;
    if (gone.size) {
      const rm = await git(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...[...gone].map(literal)], root, 0, env);
      if (!rm.ok) return rm;
    }
    if (present.size) {
      const add = await git(['add', '-A', '--', ...[...present].map(literal)], root, 0, env);
      if (!add.ok) return add;
    }
    // another commit since the index was read (an agent's) would be undone by this one's older tree
    const now = await git(['rev-parse', '-q', '--verify', 'HEAD'], root);
    if ((now.ok ? now.stdout.trim() : null) !== before) return refused('The branch moved while the commit was being made. Try again.');
    const commit = await git(['commit', '-m', message], root, COMMIT_MS, env);
    if (!commit.ok) return commit;
    // the repository's index takes every path the commit changed (a hook may have added more than the ticked files);
    // every other entry stays as it was
    const changed = await git(
      before
        ? ['diff-tree', '-r', '-z', '--name-only', '--relative', '--no-commit-id', before, 'HEAD']
        : ['diff-tree', '-r', '-z', '--name-only', '--relative', '--root', 'HEAD'],
      root,
    );
    const paths = changed.ok ? changed.stdout.split('\0').filter(Boolean) : [...gone, ...present];
    const reset = paths.length
      ? await git(['reset', '-q', 'HEAD', '--', ...paths.map(literal)], root)
      : { ok: true, stdout: '', stderr: '' };
    if (reset.ok && changed.ok) return commit;
    console.warn(`[commitFiles] committed, but the index could not be updated: ${reset.stderr || changed.stderr}`);
    return { ...commit, warning: 'Committed, but git’s index couldn’t be updated: run git status before committing again.' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { commitWith };
