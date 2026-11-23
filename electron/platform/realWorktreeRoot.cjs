// A guard for unit tests: under `node --test`, nothing may prune or remove inside the real user's managed worktree root (#3909).
const os = require('node:os');
const path = require('node:path');

/**
 * Whether `p` is the real default worktree root (under the account's real home, not a mocked one) or inside it while
 * running under the node test runner. A test that resolved an empty root to it deleted real worktrees on 2026-11-06.
 * @param {string} p
 * @param {NodeJS.ProcessEnv} [env]
 */
function touchesRealRootUnderTest(p, env = process.env) {
  if (!env.NODE_TEST_CONTEXT) return false;
  const real = path.join(os.userInfo().homedir, '.mopilot', 'worktrees');
  const rel = path.relative(real, path.resolve(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

module.exports = { touchesRealRootUnderTest };
