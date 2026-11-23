// What a chat can start from, as the branch picker's search names it: a GitHub pull request or issue of the folder's origin repository (`#12`, or either's link), or a Linear issue (ENG-12, or its link) when Linear is connected.
const { startRef } = require('../../shared/startRef.mjs');
const { findPullRequest } = require('./prSource.cjs');
const { findIssue } = require('./issueSource.cjs');

/** @typedef {import('./prCreate.cjs').Run} Run */

/** Main's Linear connection (ipc/linear.cjs sets it), or null before it is. */
let linear = /** @type {{ find(text: unknown, o?: { withText?: boolean }): Promise<any> } | null} */ (null);
const setLinear = (/** @type {typeof linear} */ l) => (linear = l);

/**
 * The pull request or issue `text` names in `cwd`'s origin repository, or why not. `#12` is a pull request when origin
 * has one of that number, else its issue: GitHub numbers both in one series, so at most one of them exists.
 * @param {Run} run
 * @param {string} cwd
 * @param {unknown} text
 */
async function findStartSource(run, cwd, text) {
  const ref = startRef(text);
  if (!ref) return { ok: false, error: 'Type # and a number, or paste a pull request’s or an issue’s link.' };
  if (ref.kind === 'linear') return linear ? linear.find(text) : { ok: false, error: 'Linear isn’t ready yet. Try again in a moment.' };
  if (ref.kind === 'issue') {
    // an issue's link to a pull request's number (GitHub redirects it to the pull request) starts from that pull request
    const issue = await findIssue(run, cwd, ref.number, { repo: ref.repo });
    return !issue.ok && 'pull' in issue ? findPullRequest(run, cwd, `#${ref.number}`) : issue;
  }
  const pr = await findPullRequest(run, cwd, text);
  if (pr.ok || !('missing' in pr) || ref.kind === 'pull') return pr;
  const issue = await findIssue(run, cwd, ref.number);
  return issue.ok || !('missing' in issue) ? issue : { ok: false, error: `${pr.missing} has no pull request or issue #${ref.number}.` };
}

module.exports = { findStartSource, setLinear };
