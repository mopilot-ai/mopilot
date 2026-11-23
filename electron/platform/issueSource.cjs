// Start a chat from a GitHub issue: which one a reference names in the folder's origin repository, and its text quoted for the agent as a description of the work, not instructions.
const { originRepo, ghFailure, NOT_GITHUB, GH_MS, MAX_TITLE } = require('./prSource.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');
const { quotedTask, shown } = require('../../shared/quotedTask.mjs');

/** @typedef {import('./prCreate.cjs').Run} Run */
/** @typedef {import('./prSource.cjs').Refusal} Refusal */

const STATES = new Set(['OPEN', 'CLOSED']);

/**
 * Issue `number` of `cwd`'s origin repository (`repo`, when the reference named one, must be it): `{ ok, kind: 'issue',
 * number, title, url, state }`, with `context` (its text, quoted for the agent) when `withText`. `{ ok: false, error }`
 * says why not; `missing` when origin has no issue of that number.
 * @param {Run} run
 * @param {string} cwd
 * @param {number} number
 * @param {{ repo?: string | null, withText?: boolean }} [o]
 */
async function findIssue(run, cwd, number, { repo: named = null, withText = false } = {}) {
  const repo = await originRepo(run, cwd);
  if (!repo) return { ok: false, error: NOT_GITHUB };
  if (named && named !== repo) return { ok: false, error: `That issue is in ${named}, not in ${repo}.` };
  const fields = `number,title,url,state${withText ? ',body' : ''}`;
  const r = await run('gh', ['issue', 'view', String(number), '--repo', repo, '--json', fields], { cwd, timeout: GH_MS });
  if (!r.ok) {
    /** @type {Refusal} */
    const missing = { ok: false, error: `${repo} has no issue #${number}.`, missing: repo };
    return ghFailure(r, repo, number, /could not resolve to an issue|no issues? found/i, missing, 'gh issue view');
  }
  /** @type {any} */
  let issue = null;
  try {
    issue = JSON.parse(r.stdout);
  } catch (error) {
    // answered with something other than JSON: said below as incomplete
    noteIgnored('read gh issue view output', error);
  }
  // gh answers `issue view` for a pull request's number too (its url says so, and its state may be MERGED): that one
  // starts on its branch, as a pull request
  if (issue && typeof issue.url === 'string' && /\/pull\/\d+$/.test(issue.url))
    return { ok: false, error: `#${number} in ${repo} is a pull request, not an issue.`, pull: true };
  if (
    !issue ||
    issue.number !== number ||
    typeof issue.title !== 'string' ||
    typeof issue.url !== 'string' ||
    !STATES.has(issue.state) ||
    (withText && typeof issue.body !== 'string')
  )
    return { ok: false, error: 'GitHub returned incomplete issue data. Try again.' };
  // a title is one line as GitHub shows it; nothing in it may break out of the line it is quoted on
  const title = prefixUnits(shown(issue.title).replace(/\s+/g, ' ').trim(), MAX_TITLE);
  const found = { ok: true, kind: /** @type {const} */ ('issue'), number, title, url: issue.url, state: issue.state };
  return withText ? { ...found, context: issueContext(repo, found, issue.body) } : found;
}

/**
 * The issue as the chat's first message carries it: who wrote it is unknown, so it is fenced as quoted text (a fence
 * longer than any backtick run in it, after the cut), introduced as a description of the work, never as instructions,
 * with what GitHub hides removed, and followed by a line saying where the user's own words begin.
 * @param {string} repo
 * @param {{ number: number, title: string, url: string, state: string }} issue
 * @param {string} body
 */
function issueContext(repo, issue, body) {
  const intro = `This chat starts from GitHub issue #${issue.number} in ${repo} (${issue.url}), ${issue.state.toLowerCase()}.`;
  return quotedTask({ intro, where: 'GitHub', title: issue.title, body });
}

/**
 * Issue `number` found again when the chat starts (it may have changed since it was picked), with its text.
 * @param {Run} run
 * @param {string} cwd
 * @param {unknown} number
 */
async function fetchIssue(run, cwd, number) {
  if (!Number.isSafeInteger(number) || /** @type {number} */ (number) < 1) return { ok: false, error: 'Invalid issue number.' };
  return findIssue(run, cwd, /** @type {number} */ (number), { withText: true });
}

module.exports = { findIssue, fetchIssue, issueContext };
