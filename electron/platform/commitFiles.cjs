// The Changes pane's commit, in main: every uncommitted change, or only the ticked files, built in an index of its own so the repository's index changes only once the commit is made (commitCore.cjs, which a machine's Host runs too).
const { git: runGit } = require('./gitRun.cjs');
const shellEnv = require('./env.cjs');
const { commitWith } = require('./commitCore.cjs');

/**
 * Commit in `root` (the repository root, which `files`' paths are relative to) with `message`: every change when `files` is null, else only those files.
 * @param {unknown} root @param {unknown} message @param {unknown} files
 * @param {{ git?: import('./commitCore.cjs').Git }} [deps]
 */
const commitFiles = (root, message, files, { git = runGit } = {}) =>
  commitWith(root, message, files, { git, baseEnv: () => shellEnv.gitEnv() });

module.exports = { commitFiles };
