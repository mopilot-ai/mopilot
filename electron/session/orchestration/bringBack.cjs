// A linked session's work in git, read for its parent and acted on from its card: the facts its note carries (branch,
// commits ahead of the parent's branch, files changed, uncommitted files, its pull request) so the parent never has to
// trust the session's own account of them, and the user's "Merge into <branch>" and "Open PR" for a session that worked
// in its own worktree. Every git and gh call has a time limit; a failed read leaves the facts out, never wrong.
const { proc: childProcess } = require('../../platform/ports/proc.cjs');
const { parseNumstatZ } = require('../../platform/gitParse.cjs');
const { git: runGit } = require('../../platform/gitRun.cjs');
const shellEnv = require('../../platform/env.cjs');

/** @typedef {{ ok: boolean, stdout: string, stderr: string }} RunResult */
/** @typedef {{ git: (args: string[], cwd: string, timeout?: number) => Promise<RunResult>, gh: (args: string[], cwd: string, timeout?: number) => Promise<RunResult> }} Runners */

/** gh without a shell, resolving its outcome and never rejecting, as gitRun's git does. */
function runGh(args, cwd, timeout = 0) {
  return new Promise((resolve) => {
    childProcess.execFile(
      'gh',
      args,
      { cwd, timeout, env: shellEnv.gitEnv(), maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** @type {Runners} */
const RUNNERS = { git: runGit, gh: runGh };

const GIT_MS = 10_000;
const GH_MS = 15_000;

/** The branch checked out in `cwd`, or null (detached, or not a repository). */
async function currentBranch({ git }, cwd) {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, GIT_MS);
  const b = r.ok ? r.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : null;
}

/** The pull request for `branch`, the newest whatever its state, or null (none, or gh can't say). */
async function pullRequestOf({ gh }, cwd, branch) {
  const r = await gh(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,url,isDraft'], cwd, GH_MS);
  if (!r.ok) return null;
  try {
    const [pr] = JSON.parse(r.stdout);
    return pr && Number.isInteger(pr.number) && typeof pr.url === 'string'
      ? { number: pr.number, state: pr.state === 'OPEN' && pr.isDraft === true ? 'DRAFT' : String(pr.state), url: pr.url }
      : null;
  } catch {
    return null;
  }
}

/**
 * What git says a session in its own worktree did, against the branch its parent has checked out: null when either
 * side can't be read, or they are the same branch.
 * @param {Runners} run
 * @param {{ childCwd: string, parentCwd: string, branch: string }} o
 */
async function branchFacts(run, { childCwd, parentCwd, branch }) {
  const base = await currentBranch(run, parentCwd);
  if (!base || base === branch) return null;
  const [ahead, diff, status, pr] = await Promise.all([
    run.git(['rev-list', '--count', `${base}..${branch}`], childCwd, GIT_MS),
    run.git(['diff', '--numstat', '-z', `${base}...${branch}`], childCwd, GIT_MS),
    run.git(['status', '--porcelain=v1', '-uall'], childCwd, GIT_MS),
    pullRequestOf(run, childCwd, branch),
  ]);
  if (!ahead.ok || !diff.ok) return null;
  const files = Object.values(parseNumstatZ(diff.stdout));
  return {
    branch,
    base,
    ahead: Number.parseInt(ahead.stdout.trim(), 10) || 0,
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    uncommitted: status.ok ? status.stdout.split('\n').filter(Boolean).length : 0,
    pr,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The facts as the parent's note states them; the app read them, so they are facts, not the session's words. */
function factsText(f) {
  const parts = [
    `branch ${f.branch}, ${plural(f.ahead, 'commit')} ahead of ${f.base}`,
    `${plural(f.files, 'file')} changed (+${f.added} -${f.removed})`,
  ];
  if (f.uncommitted) parts.push(`${plural(f.uncommitted, 'file')} not committed in its worktree`);
  if (f.pr) parts.push(`pull request #${f.pr.number} (${f.pr.state.toLowerCase()})`);
  return `Git (read by the app): ${parts.join('; ')}.`;
}

/**
 * Merge a session's branch into the folder its parent works in: refused while that folder has uncommitted changes to
 * tracked files; a dry run first (git merge-tree) names the files that would conflict, and then nothing is changed.
 * @param {Runners} run
 * @param {{ parentCwd: string, branch: string }} o
 * @returns {Promise<{ status: 'merged', into: string, commit: string } | { status: 'conflicts', into: string, files: string[] } | { status: 'refused', reason: string, message: string }>}
 */
async function mergeBranch(run, { parentCwd, branch }) {
  const into = await currentBranch(run, parentCwd);
  if (!into) return { status: 'refused', reason: 'no_branch', message: 'This chat’s folder has no branch checked out to merge into.' };
  const dirty = await run.git(['status', '--porcelain=v1', '-uno'], parentCwd, GIT_MS);
  if (!dirty.ok || dirty.stdout.trim())
    return {
      status: 'refused',
      reason: 'parent_dirty',
      message: `${into} has uncommitted changes in this chat’s folder: commit or stash them, then merge.`,
    };
  // exit 1 with the conflicted files after the tree id; another failure (an old git, a bad ref) says so in stderr
  const dry = await run.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch], parentCwd, GIT_MS);
  const lines = dry.stdout.split('\n').filter(Boolean);
  if (!dry.ok && lines.length > 1) return { status: 'conflicts', into, files: lines.slice(1) };
  if (!dry.ok)
    return { status: 'refused', reason: 'merge_check_failed', message: `Couldn’t check the merge: ${dry.stderr.trim() || 'git failed'}` };
  const merged = await run.git(['merge', '--no-ff', '--no-edit', branch], parentCwd, 60_000);
  if (!merged.ok) {
    await run.git(['merge', '--abort'], parentCwd, GIT_MS);
    return { status: 'refused', reason: 'merge_failed', message: `Couldn’t merge ${branch}: ${merged.stderr.trim() || 'git failed'}` };
  }
  const head = await run.git(['rev-parse', '--short', 'HEAD'], parentCwd, GIT_MS);
  return { status: 'merged', into, commit: head.stdout.trim() };
}

/**
 * Open a pull request for a session's branch: push it, then open GitHub's form for it (as the app's own "Create PR"
 * does), where the user writes and submits it.
 * @param {Runners} run
 * @param {{ childCwd: string, branch: string }} o
 * @returns {Promise<{ status: 'opened' } | { status: 'refused', reason: string, message: string }>}
 */
async function openPullRequest(run, { childCwd, branch }) {
  const push = await run.git(['push', '-u', 'origin', branch], childCwd, 60_000);
  if (!push.ok)
    return { status: 'refused', reason: 'push_failed', message: `Couldn’t push ${branch}: ${push.stderr.trim() || 'git failed'}` };
  const form = await run.gh(['pr', 'create', '--web', '--head', branch], childCwd, GH_MS);
  if (!form.ok)
    return { status: 'refused', reason: 'gh_failed', message: `Couldn’t open the pull request form: ${form.stderr.trim() || 'gh failed'}` };
  return { status: 'opened' };
}

module.exports = { RUNNERS, branchFacts, factsText, mergeBranch, openPullRequest, pullRequestOf, currentBranch };
