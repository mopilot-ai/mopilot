// Discard Git file changes by index state, preserving literal filenames and restoring both trees. This Mac's Changes pane (src/lib/gitDiscard.ts) and a machine's Host (host/src/hostWrite.mjs) run the same steps over their own git runner.
import { parseGitPathLine } from './gitPathLine.mjs';
import { isUnbornHead } from './gitHead.mjs';

/** @typedef {{ ok: boolean, stdout: string, stderr: string, code?: number | string }} Result */
/** @typedef {{ run(cwd: string, args: string[]): Promise<Result> }} Git */

/** Resolve the repository root without trimming filename whitespace. */
/** @param {Git} git @param {string} cwd @returns {Promise<Result>} */
async function repositoryRoot(git, cwd) {
  const result = await git.run(cwd, ['rev-parse', '--show-toplevel']);
  const root = parseGitPathLine(result.stdout);
  return result.ok && root
    ? { ...result, stdout: root }
    : { ...result, ok: false, stderr: result.stderr || 'Could not read repository root' };
}

/** Restore tracked paths from HEAD, or from an empty tree before the first commit; `cwd` is the repository root. */
/** @param {Git} git @param {string} cwd @param {string[]} paths @param {boolean} [folder] the one path is a folder, not a file @returns {Promise<Result>} */
export async function restoreFromRoot(git, cwd, paths, folder = false) {
  let source = 'HEAD';
  const head = await git.run(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) {
    if (!(await isUnbornHead((args) => git.run(cwd, args)))) return head;
    const empty = await git.run(cwd, ['hash-object', '-w', '-t', 'tree', '--', '/dev/null']);
    if (!empty.ok) return empty;
    if (!empty.stdout.trim()) return { ok: false, stdout: '', stderr: 'Could not read empty repository tree' };
    source = empty.stdout.trim();
  }
  // a whole folder (`.` or the one `folder` names) with nothing tracked in it has nothing to restore
  if (paths.length === 1 && (folder || paths[0] === '.')) {
    const index = await git.run(cwd, ['ls-files', '-z', '--', paths[0]]);
    if (!index.ok) return index;
    if (!index.stdout) {
      const tree = await git.run(cwd, ['ls-tree', '-r', '--name-only', '-z', source, '--', paths[0]]);
      if (!tree.ok) return tree;
      if (!tree.stdout) return { ok: true, stdout: '', stderr: '' };
    }
  }
  return git.run(cwd, ['restore', `--source=${source}`, '--staged', '--worktree', '--', ...paths]);
}

/** The diff's isNew flag describes its baseline; consult the index before discarding. @param {Git} git @param {string} cwd @param {string} path relative to the repository's root @returns {Promise<Result>} */
export async function discardGitFile(git, cwd, path) {
  const root = await repositoryRoot(git, cwd);
  if (!root.ok) return root;
  cwd = root.stdout;
  const literal = `:(literal)${path}`;
  const tracked = await git.run(cwd, ['ls-files', '--error-unmatch', '--', literal]);
  if (tracked.ok) {
    // Query the index's rename, rather than a branch diff whose baseline may predate HEAD.
    const staged = await git.run(cwd, ['diff', '--cached', '--name-status', '--find-renames', '-z']);
    if (!staged.ok) return staged;
    const records = staged.stdout.split('\0');
    const paths = [literal];
    for (let i = 0; i < records.length - 1; ) {
      const status = records[i++];
      const from = records[i++];
      if (/^[RC]\d+$/.test(status)) {
        const to = records[i++];
        if (status.startsWith('R') && to === path) paths.unshift(`:(literal)${from}`);
      }
    }
    return restoreFromRoot(git, cwd, paths);
  }
  if (tracked.code !== 1) return tracked;
  // Staged deletions are absent from the index but must still be restored from HEAD.
  const deleted = await git.run(cwd, ['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=D', '-z', '--', literal]);
  if (!deleted.ok) return deleted;
  if (deleted.stdout) return restoreFromRoot(git, cwd, [literal]);
  return git.run(cwd, ['clean', '-f', '--', literal]);
}

/**
 * Discard the repository's tracked edits before cleaning untracked files; `scope` (a folder of the repository, relative to its root, default all of it) keeps the discard to that folder.
 * @param {Git} git @param {string} cwd @param {string} [scope] @returns {Promise<Result>}
 */
export async function discardGitChanges(git, cwd, scope = '.') {
  const root = await repositoryRoot(git, cwd);
  if (!root.ok) return root;
  // a folder is named literally: `*`, `[` and `?` in its name match nothing else
  const where = scope === '.' ? scope : `:(literal)${scope}`;
  const restored = await restoreFromRoot(git, root.stdout, [where], true);
  if (!restored.ok) return { ...restored, stderr: restored.stderr || 'Could not discard tracked changes' };
  const cleaned = await git.run(root.stdout, ['clean', '-fd', '--', where]);
  return cleaned.ok ? cleaned : { ...cleaned, stderr: cleaned.stderr || 'Could not remove untracked files' };
}
