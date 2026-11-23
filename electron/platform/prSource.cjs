// Start a chat from a GitHub pull request: which one a typed reference names in the folder's origin repository, and fetching its head for a worktree to check out.
const { githubRepo } = require('../../shared/mainRepairRepository.mjs');
const { pullRequestRef } = require('../../shared/pullRequestRef.mjs');
const { safeRef, signInProblem, SIGN_IN, NO_ANSWER } = require('./prCreate.cjs');
const { forkRef } = require('./worktreeSource.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** @typedef {import('./prCreate.cjs').Run} Run */
/** @typedef {{ ok: false, error: string, missing?: string }} Refusal `missing`: the repository has nothing of that number */

const GIT_MS = 10_000;
const FETCH_MS = 120_000;
const GH_MS = 30_000;
const MAX_TITLE = 256;
const FIELDS = 'number,title,url,state,headRefName,baseRefName,isCrossRepository';
const STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const NOT_GITHUB = 'This folder’s origin is not a GitHub repository.';

/**
 * `cwd`'s origin as a GitHub `owner/name` (lowercased), else null.
 * @param {Run} run
 * @param {string} cwd
 */
async function originRepo(run, cwd) {
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd, timeout: GIT_MS });
  return remote.ok ? githubRepo(remote.stdout) : null;
}

/**
 * Why gh couldn't look up `#number` in `repo`, in words for the window: `notFound` matching its words says `missing`;
 * any other failure's own words go to the log.
 * @param {{ stdout: string, stderr: string }} r
 * @param {string} repo
 * @param {number} number
 * @param {RegExp} notFound
 * @param {Refusal} missing
 * @param {string} what the gh command, for the log
 * @returns {Refusal}
 */
function ghFailure(r, repo, number, notFound, missing, what) {
  const said = `${r.stderr}\n${r.stdout}`.trim();
  if (signInProblem(said)) return { ok: false, error: SIGN_IN };
  if (/could not resolve to a repository/i.test(said))
    return { ok: false, error: `GitHub CLI can’t see ${repo}. Sign in with an account that can read it: run \`gh auth login\`.` };
  if (notFound.test(said)) return missing;
  if (!said) return { ok: false, error: NO_ANSWER };
  console.warn(`[prSource] ${what} #${number} in ${repo} failed: ${said}`);
  return { ok: false, error: `GitHub CLI couldn’t look up #${number}. Try again.` };
}

/**
 * The pull request `text` names in `cwd`'s origin repository: `{ ok, number, title, url, state, base, head, fork, own,
 * checkout }`. `own`: its head is an open branch of origin's, worked on as itself (`checkout` is that branch); else a
 * fork's head, or a closed pull request's whose branch may be gone or reused, is worked on as a copy, `pr/<n>`.
 * `{ ok: false, error }` says why not, in words for the window (gh's own go to the log).
 * @param {Run} run
 * @param {string} cwd
 * @param {unknown} text
 */
async function findPullRequest(run, cwd, text) {
  const ref = pullRequestRef(text);
  if (!ref) return { ok: false, error: 'Type # and a pull request number, or paste its link.' };
  const repo = await originRepo(run, cwd);
  if (!repo) return { ok: false, error: NOT_GITHUB };
  if (ref.repo && ref.repo !== repo) return { ok: false, error: `That pull request is in ${ref.repo}, not in ${repo}.` };
  const r = await run('gh', ['pr', 'view', String(ref.number), '--repo', repo, '--json', FIELDS], { cwd, timeout: GH_MS });
  if (!r.ok) {
    /** @type {Refusal} */
    const missing = { ok: false, error: `${repo} has no pull request #${ref.number}.`, missing: repo };
    return ghFailure(r, repo, ref.number, /could not resolve to a pullrequest|no pull requests? found/i, missing, 'gh pr view');
  }
  /** @type {any} */
  let pr = null;
  try {
    pr = JSON.parse(r.stdout);
  } catch (error) {
    // answered with something other than JSON: said below as incomplete
    noteIgnored('read gh pr view output', error);
  }
  if (
    !pr ||
    pr.number !== ref.number ||
    !safeRef(pr.headRefName) ||
    !safeRef(pr.baseRefName) ||
    typeof pr.title !== 'string' ||
    typeof pr.url !== 'string' ||
    !STATES.has(pr.state)
  )
    return { ok: false, error: 'GitHub returned incomplete pull request data. Try again.' };
  const fork = pr.isCrossRepository === true;
  const own = !fork && pr.state === 'OPEN';
  return {
    ok: true,
    number: pr.number,
    title: pr.title.slice(0, MAX_TITLE),
    url: pr.url,
    state: pr.state,
    base: pr.baseRefName,
    head: pr.headRefName,
    fork,
    own,
    checkout: own ? pr.headRefName : `pr/${pr.number}`,
  };
}

/**
 * Find pull request `number` again (it may have changed since it was picked) and fetch its head: origin's own open branch
 * into its remote-tracking ref, any other pull request's head (GitHub keeps it as refs/pull/<n>/head) into forkRef. No
 * local branch is written here.
 * @param {Run} run
 * @param {string} cwd
 * @param {unknown} number
 */
async function fetchPullRequest(run, cwd, number) {
  if (!Number.isSafeInteger(number) || /** @type {number} */ (number) < 1) return { ok: false, error: 'Invalid pull request number.' };
  const pr = await findPullRequest(run, cwd, `#${number}`);
  if (!pr.ok) return pr;
  const spec = pr.own ? `+refs/heads/${pr.head}:refs/remotes/origin/${pr.head}` : `+refs/pull/${pr.number}/head:${forkRef(pr.number)}`;
  const f = await run('git', ['fetch', '--no-tags', 'origin', spec], { cwd, timeout: FETCH_MS });
  if (!f.ok) {
    console.warn(`[prSource] git fetch of pull request #${pr.number} failed: ${f.stderr.trim()}`);
    return {
      ok: false,
      error: `Couldn’t fetch pull request #${pr.number} from origin. Check the connection and that you can read the repository, then try again.`,
    };
  }
  return pr;
}

module.exports = { findPullRequest, fetchPullRequest, originRepo, ghFailure, NOT_GITHUB, GH_MS, MAX_TITLE };
