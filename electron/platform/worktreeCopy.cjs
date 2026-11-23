// Files a new worktree gets from its repository: the git-ignored files (.env and the like) that match the repository's copy patterns, copied once and never over a file that is there.
const path = require('node:path');
const { fs } = require('./ports/fs.cjs');
const { git: runGit } = require('./gitRun.cjs');
const { resolveEnvironment } = require('./environmentSource.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** Bounds on one worktree's copy: it is for config and secrets, not for dependencies or build output. */
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const LIST_TIMEOUT_MS = 20_000;

const firstLine = (error) => String(error?.message ?? error).split('\n')[0];
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const zList = (out) => out.split('\0').filter(Boolean);

/**
 * The nearest thing at or above `dir` that exists, with links resolved; null when it can't be resolved (a link whose
 * target is gone counts as there: making folders "under" it would make them wherever it points).
 */
function realAncestor(dir) {
  let d = dir;
  // the file system's top is always there
  while (!fs.lstatSync(d, { throwIfNoEntry: false })) d = path.dirname(d);
  try {
    return fs.realpathSync(d);
  } catch {
    return null;
  }
}

/**
 * Copy into the new worktree `dir` the files of the checkout that `repo` is in which match its copy patterns
 * (environmentSource.cjs: `.worktreeinclude`, else Conductor's globs, else `.env*` beside a Conductor config) and that
 * git ignores there. `repo` is the checkout's top folder: git lists paths from the folder it runs in, and from the top
 * they are the same in the worktree (copyIgnoredFrom takes a folder inside it). Patterns are matched by git itself, so they mean
 * what they mean in a .gitignore. The `.env*` default, which no one wrote for this repository, leaves alone whatever is
 * inside a folder git ignores as a whole (a virtualenv named .env, a dependency's own .env.example). Only regular files
 * are copied, only to a place inside the worktree, and never over anything: a file the branch already has, or one
 * copied before, stays. Both folders are on this machine; a worktree on another machine gets nothing from here.
 *
 * A pattern that names a very large folder can make the listing too big to read: nothing is copied then, and it says so.
 * Never throws: what was not copied is in `skipped`, why nothing or not everything could be in `problem`, and `notice`
 * says both in one line for whoever made the worktree ('' when there is nothing to say). The system's own words for a
 * failure go to main's record, not into the line.
 * @param {string} repo the top folder of the checkout the worktree was made from
 * @param {string} dir the new worktree's top folder
 * @param {{ git?: typeof runGit, resolve?: typeof resolveEnvironment, maxFiles?: number, maxFileBytes?: number,
 *   maxTotalBytes?: number, warn?: typeof noteIgnored, copyFile?: (from: string, to: string, mode: number) => Promise<void> }} [o]
 * @returns {Promise<{ copied: string[], skipped: { path: string, reason: string }[], problem: string | null, notice: string }>}
 */
async function copyIgnored(repo, dir, o = {}) {
  const warn = o.warn ?? noteIgnored;
  const out = await copied(repo, dir, o, warn);
  const notice = copyNotice(out);
  // a start with no window to say it in (a scheduled task) still leaves a record
  if (notice) warn('copy files into a new worktree', new Error(notice));
  return { ...out, notice };
}

async function copied(top, dir, o, warn) {
  const {
    git = runGit,
    resolve = resolveEnvironment,
    maxFiles = MAX_FILES,
    maxFileBytes = MAX_FILE_BYTES,
    maxTotalBytes = MAX_TOTAL_BYTES,
  } = o;
  const copyFile = o.copyFile ?? ((from, to, mode) => fs.promises.copyFile(from, to, mode));
  /** @type {string[]} */
  const problems = [];
  /** @type {{ copied: string[], skipped: { path: string, reason: string }[], problem: string | null }} */
  const out = { copied: [], skipped: [], problem: null };
  try {
    const env = resolve(top);
    if (env.copyError) problems.push(env.copyError);
    if (env.copy.length) await copyMatched(top, dir, env, { git, maxFiles, maxFileBytes, maxTotalBytes, copyFile, warn }, out, problems);
  } catch (error) {
    warn('read the files to copy into a new worktree', error);
    problems.push("The files to copy into the worktree couldn't be read");
  }
  if (problems.length) out.problem = problems.join('. ');
  return out;
}

/**
 * copyIgnored for a worktree of the checkout `folder` is in: a chat records its project's folder, which in a monorepo is
 * not the checkout's top. A folder git can't place is used as it is.
 * @param {string} folder @param {string} dir @param {Parameters<typeof copyIgnored>[2]} [o]
 */
async function copyIgnoredFrom(folder, dir, o = {}) {
  const top = (await (o.git ?? runGit)(['rev-parse', '--show-toplevel'], folder)).stdout.trim();
  return copyIgnored(top || folder, dir, o);
}

async function copyMatched(top, dir, env, { git, maxFiles, maxFileBytes, maxTotalBytes, copyFile, warn }, out, problems) {
  // what matches the patterns, and what git ignores (whole ignored folders as `name/`): a file must be in both, so an
  // untracked file the user has yet to commit never lands in the worktree as a stray
  const [matched, ignored] = await Promise.all([
    git(['ls-files', '--others', '--ignored', '-z', ...env.copy.map((p) => `--exclude=${p}`)], top, LIST_TIMEOUT_MS),
    git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], top, LIST_TIMEOUT_MS),
  ]);
  if (!matched.ok || !ignored.ok) {
    warn(
      'list the files to copy into a new worktree',
      new Error(firstLine((matched.ok ? ignored : matched).stderr) || 'timed out, or too much to list'),
    );
    problems.push("The files to copy into the worktree couldn't be listed (too many match, or git failed), so none were copied");
    return;
  }
  const ignoredFiles = new Set(zList(ignored.stdout));
  const ignoredDirs = [...ignoredFiles].filter((p) => p.endsWith('/'));
  const underIgnoredDir = (rel) => ignoredDirs.some((d) => rel.startsWith(d));
  const wanted = env.copySource === 'default' ? (rel) => ignoredFiles.has(rel) : (rel) => ignoredFiles.has(rel) || underIgnoredDir(rel);
  // a nested repository is listed as a folder: not a file to copy
  const files = zList(matched.stdout)
    .filter((rel) => !rel.endsWith('/') && wanted(rel))
    .sort();
  const realDir = fs.realpathSync(dir);
  let bytes = 0;
  for (const rel of files) {
    const skip = (reason) => void out.skipped.push({ path: rel, reason });
    if (out.copied.length >= maxFiles) {
      problems.push(`Only the first ${maxFiles} files were copied into the worktree`);
      break;
    }
    const parts = rel.split('/');
    if (path.isAbsolute(rel) || parts.includes('..')) {
      skip('not a path inside the repository');
      continue;
    }
    try {
      const from = path.join(top, ...parts);
      const to = path.join(dir, ...parts);
      const st = fs.lstatSync(from);
      if (!st.isFile()) {
        skip('not a regular file');
        continue;
      }
      if (st.size > maxFileBytes) {
        skip('too large to copy');
        continue;
      }
      if (bytes + st.size > maxTotalBytes) {
        problems.push('Not every file was copied into the worktree: together they are too large');
        break;
      }
      // a folder the branch has as a link could lead out of the worktree: nothing is made or written through one
      const parent = realAncestor(path.dirname(to));
      if (!parent || !inside(realDir, parent)) {
        skip('its folder leads outside the worktree');
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
      } catch (error) {
        // the branch has a file where the folder would be
        warn(`make the folder for ${rel} in a new worktree`, error);
        skip("its folder couldn't be made");
        continue;
      }
      await copyFile(from, to, fs.constants.COPYFILE_EXCL);
      bytes += st.size;
      out.copied.push(rel);
    } catch (error) {
      // there already (the branch has it, or an earlier copy made it): kept, and nothing to report
      if (error?.code === 'EEXIST') continue;
      warn(`copy ${rel} into a new worktree`, error);
      skip("it couldn't be copied");
    }
  }
}

/** One line for whoever made the worktree, '' when everything that should be copied was. */
function copyNotice(result) {
  const parts = [];
  if (result.problem) parts.push(result.problem);
  if (result.skipped.length)
    parts.push(
      `Not copied into the worktree: ${result.skipped
        .slice(0, 3)
        .map((s) => `${s.path} (${s.reason})`)
        .join(', ')}${result.skipped.length > 3 ? `, and ${result.skipped.length - 3} more` : ''}`,
    );
  return parts.join('. ');
}

module.exports = { copyIgnored, copyIgnoredFrom, MAX_FILES, MAX_FILE_BYTES };
