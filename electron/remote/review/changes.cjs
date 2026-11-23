// A chat folder's changes as text for a phone, in the app's Changes-pane scopes: the working tree, the branch since its base, or one turn's saved diff. Git is only read, in the folder's own repository, and what is hidden or outside the folder is dropped.
const path = require('node:path');
const { fs: nodeFs } = require('../../platform/ports/fs.cjs');
const { createGitDiff } = require('../../platform/gitDiff.cjs');
const { parseLsFilesZ, parseGitPathLine, isNestedRepo } = require('../../platform/gitParse.cjs');
const { GIT_DIFF_FLAGS } = require('../../../shared/gitDiffFlags.mjs');
const { BRANCH_BASE_UNAVAILABLE, branchComparisonBase } = require('../../../shared/gitComparisonBase.mjs');
const { isUnbornHead } = require('../../../shared/gitHead.mjs');
const { RemoteError } = require('../serviceErrors.cjs');
const { visible } = require('./visible.cjs');
const { parseDiff } = require('./diffRows.cjs');

/** The most files one listing returns. */
const MAX_FILES = 500;

/** The text a git failure carries, for the one place the phone is told why a diff can't be read. */
const unreadable = (/** @type {string} */ what) => new RemoteError('failed', `Couldn't read ${what}.`);

/**
 * @param {object} o
 * @param {(cmd: string, args: string[], opts: { cwd: string, noLazyFetch?: boolean }) => Promise<{ ok: boolean, stdout: string, stderr?: string, code?: number | string }>} o.run
 * @param {{ realpathSync: (p: string) => string }} [o.fs]
 */
function createChanges({ run, fs = nodeFs }) {
  const workingTree = createGitDiff(run);
  const offlineWorkingTree = createGitDiff((cmd, args, opts) => run(cmd, args, { ...opts, noLazyFetch: true }));

  /** The repository root of `cwd` and where the folder sits in it ('' at the root), or a refusal when it is not a repository. */
  async function repoOf(/** @type {string} */ cwd) {
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = parseGitPathLine(top.stdout);
    if (!top.ok || !root) throw new RemoteError('failed', "This chat's folder isn't a Git repository.");
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(cwd)).split(path.sep).join('/');
    return { root, prefix: rel.startsWith('..') ? '' : rel };
  }

  /** The branch's changes: committed work since the base, pending edits and untracked files. */
  async function branchDiff(/** @type {string} */ root) {
    const git = (/** @type {string[]} */ args) => run('git', args, { cwd: root, noLazyFetch: true });
    const base = await branchComparisonBase(git);
    if (base === 'HEAD' || (base === null && (await isUnbornHead(git)))) return offlineWorkingTree(root, undefined, true);
    if (base === null) throw new RemoteError('failed', BRANCH_BASE_UNAVAILABLE);
    const result = await git(['diff', base, ...GIT_DIFF_FLAGS]);
    if (!result.ok) throw unreadable('the branch changes');
    let out = result.stdout;
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z']);
    if (!untracked.ok) throw unreadable('the untracked files');
    for (const name of parseLsFilesZ(untracked.stdout)) {
      if (isNestedRepo(name)) continue;
      const diff = await git(['diff', '--no-index', ...GIT_DIFF_FLAGS, '--', '/dev/null', name]);
      // no-index exits with 1 when the new file differs from /dev/null
      if (!diff.ok && (diff.code !== 1 || !diff.stdout)) throw unreadable('an untracked file');
      out += diff.stdout;
    }
    return out;
  }

  /**
   * The files a scope changed in the folder, folder-relative, with rows. Hidden files and files outside the folder are
   * left out (`omitted` counts them, naming none).
   * @param {{ cwd: string, scope: 'branch' | 'uncommitted' | 'turn', turn?: () => Promise<string | undefined> }} q
   */
  async function filesOf({ cwd, scope, turn }) {
    const { root, prefix } = await repoOf(cwd);
    let text;
    if (scope === 'turn') text = await turn?.();
    else text = scope === 'branch' ? await branchDiff(root) : await workingTree(root, undefined, true);
    if (text === undefined) throw new RemoteError('gone', "That turn's changes aren't available.");
    const inside = (/** @type {string | undefined} */ p) => {
      if (p === undefined || p.startsWith('/')) return null;
      if (!prefix) return p;
      return p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : null;
    };
    const files = [];
    let omitted = 0;
    for (const f of parseDiff(text)) {
      const p = inside(f.path);
      const { oldPath, ...rest } = f;
      // a rename from outside the folder shows as the new file alone
      const old = oldPath === undefined ? null : inside(oldPath);
      if (p === null || !visible(p) || (old && !visible(old))) omitted++;
      else files.push({ ...rest, path: p, ...(old ? { oldPath: old } : {}) });
    }
    return { files, omitted };
  }

  return { filesOf };
}

module.exports = { createChanges, MAX_FILES };
