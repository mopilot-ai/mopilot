// The files git lists as unmerged (a conflict not yet resolved): one reading of `git ls-files -u -z` for this Mac's commit and Changes pane and for a machine's Host, so a commit that refuses and a row that says "Conflicted" never disagree.

/** The arguments that list the unmerged index entries, paths relative to the folder git runs in. */
export const UNMERGED_ARGS = ['ls-files', '-u', '-z'];

/**
 * The distinct paths of `git ls-files -u -z` output (one `<mode> <sha> <stage>\t<path>` record per stage, up to three per path).
 * @param {string} stdout @returns {string[]}
 */
export function unmergedPaths(stdout) {
  const paths = new Set();
  for (const record of String(stdout || '').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab > 0) paths.add(record.slice(tab + 1));
  }
  return [...paths];
}

/** What a commit says when `count` files are in conflict. @param {number} count */
export const conflictsSentence = (count) => `Resolve conflicts in ${count === 1 ? '1 file' : `${count} files`} first`;
