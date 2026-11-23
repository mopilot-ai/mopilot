// The commit a phone build was made from: stamped into the app's config so Settings › About names it, and checked against the tree the build was asked for before a build is installed.
const { execFileSync } = require('node:child_process');

const HASH = /^[0-9a-f]{7,40}$/;

/** `<short sha>` of the tree at `dir`, with `-dirty` when it has uncommitted changes; undefined where there is no git tree. @param {string} dir @param {(args: string[], dir: string) => string} [git] */
function treeCommit(dir, git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  try {
    const sha = git(['rev-parse', '--short=9', 'HEAD'], dir).trim();
    if (!HASH.test(sha)) return undefined;
    return git(['status', '--porcelain', '--untracked-files=no'], dir).trim() ? `${sha}-dirty` : sha;
  } catch {
    return undefined;
  }
}

/** The stamp for a build: MOPILOT_BUILD_COMMIT when set (a build outside a git tree), otherwise the tree this config is read from. @param {NodeJS.ProcessEnv} env @param {string} dir */
function buildCommit(env, dir) {
  const given = (env.MOPILOT_BUILD_COMMIT ?? '').trim();
  if (given) {
    if (!/^[0-9a-f]{7,40}(-dirty)?$/.test(given)) throw new Error(`MOPILOT_BUILD_COMMIT must be a short or full commit sha, got ${JSON.stringify(given)}`);
    return given;
  }
  return treeCommit(dir);
}

module.exports = { buildCommit, treeCommit };
