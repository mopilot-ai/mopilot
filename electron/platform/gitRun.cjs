// Runs one git command without a shell and resolves its outcome, never rejecting: managed worktrees
// (electron/platform/git.cjs) and plugin marketplaces (electron/plugins/marketplaces.cjs) both use it.
const childProcess = require('node:child_process');
const shellEnv = require('./env.cjs');

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout] milliseconds, 0 for none
 * @param {NodeJS.ProcessEnv} [env] the command's environment (by default the login shell's: a Dock launch's own PATH
 *   is launchd's, which misses the user's git, #1580)
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
function git(args, cwd, timeout = 0, env = shellEnv.gitEnv()) {
  return new Promise((resolve) => {
    childProcess.execFile('git', args, { cwd, timeout, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

module.exports = { git };
