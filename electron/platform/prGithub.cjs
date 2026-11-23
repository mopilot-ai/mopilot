// Read and validate PR checks, conflicts and trusted review feedback through GitHub CLI.
const { createHash } = require('node:crypto');
const { pullRequestUrl } = require('../../shared/pullRequest.mjs');

const FIELDS = 'url,state,title,headRefOid,headRefName,baseRefName,mergeable,statusCheckRollup,mergeStateStatus,labels,autoMergeRequest';
/** Labels that hand a PR to a merge robot (this repository's merge train), as src/lib/pullRequestIndicator.ts LANDING_LABELS. */
const LANDING_LABELS = new Set(['merge-on-green']);
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const CONCLUSIONS = new Set(['', 'SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE', ...FAILED]);
const RUN_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'REQUESTED', 'PENDING']);
const CONTEXT_STATES = new Set(['EXPECTED', 'PENDING', 'SUCCESS', 'ERROR', 'FAILURE']);
const key = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' && v.length > 0;
function invalid() {
  throw new Error('GitHub returned incomplete PR data. Refresh to retry.');
}

/** A single command is bounded; all requests use argv, never shell interpolation. */
async function json(run, cwd, args) {
  const result = await run('gh', args, { cwd, timeout: 30_000 });
  if (!result.ok) throw new Error(result.stderr.trim() || 'GitHub CLI failed. Check that gh is installed and signed in.');
  return JSON.parse(result.stdout);
}

/** One status rollup entry, validated: its name and state, and whether it failed or is still running. */
function classifyCheck(check) {
  if (!record(check)) invalid();
  const isRun = check.__typename === 'CheckRun';
  if (!isRun && check.__typename !== 'StatusContext') invalid();
  const name = isRun ? check.name : check.context;
  const state = isRun ? check.conclusion : check.state;
  if (
    !string(name) ||
    (isRun
      ? !CONCLUSIONS.has(state) || !RUN_STATES.has(check.status) || (check.status === 'COMPLETED' && !state)
      : !CONTEXT_STATES.has(state))
  )
    invalid();
  const failed = FAILED.has(state);
  return {
    name,
    state,
    failed,
    pending: !failed && ((isRun && check.status !== 'COMPLETED') || state === 'PENDING' || state === 'EXPECTED'),
  };
}

/** Read feedback only when enabled; pagination includes inline comments and discussion comments. */
async function readPullRequest(run, cwd, url, addressComments) {
  if (pullRequestUrl(url) !== url) throw new Error('Enter a GitHub pull request URL.');
  const pr = await json(run, cwd, ['pr', 'view', url, '--json', FIELDS]);
  if (
    !record(pr) ||
    pullRequestUrl(pr.url) !== url ||
    !['OPEN', 'MERGED', 'CLOSED'].includes(pr.state) ||
    !string(pr.headRefOid) ||
    !string(pr.title) ||
    !string(pr.headRefName) ||
    !string(pr.baseRefName) ||
    !['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr.mergeable) ||
    !Array.isArray(pr.statusCheckRollup)
  )
    invalid();
  const events = [];
  let pending = 0;
  let checksPassed = pr.statusCheckRollup.length > 0;
  for (const check of pr.statusCheckRollup) {
    const tally = classifyCheck(check);
    checksPassed = checksPassed && !tally.pending && tally.state === 'SUCCESS';
    if (tally.failed)
      events.push({
        key: key(['check', pr.headRefOid, tally.name, tally.state, check.detailsUrl, check.targetUrl, check.completedAt]),
        text: `Failing check: ${tally.name}`,
      });
    else if (tally.pending) pending++;
  }
  if (pr.mergeable === 'CONFLICTING')
    events.push({ key: key(['conflict', pr.headRefOid, pr.baseRefName]), text: 'This PR has merge conflicts.' });
  if (addressComments && pr.state === 'OPEN') {
    const viewer = await json(run, cwd, ['api', 'user']);
    if (!record(viewer) || !string(viewer.login)) invalid();
    const [, owner, repo, , number] = new URL(url).pathname.split('/');
    const inline = `repos/${owner}/${repo}/pulls/${number}/comments`;
    for (const endpoint of [`repos/${owner}/${repo}/issues/${number}/comments`, inline, `repos/${owner}/${repo}/pulls/${number}/reviews`]) {
      const pages = await json(run, cwd, ['api', endpoint, '--paginate', '--slurp']);
      if (!Array.isArray(pages) || !pages.every(Array.isArray)) invalid();
      for (const comment of pages.flat()) {
        if (!record(comment) || !record(comment.user) || !string(comment.user.login)) invalid();
        // Your own replies and reviews are not feedback (a pending self-review has no submitted_at). A top-level inline
        // comment from your account is: a code review posted to the PR as you (/code-review --comment) leaves each
        // finding that way, while the agent's answers are replies in their thread.
        const own = comment.user.login === viewer.login;
        if (own && (endpoint !== inline || comment.in_reply_to_id != null)) continue;
        if (
          !string(comment.node_id) ||
          typeof comment.body !== 'string' ||
          !string(comment.updated_at ?? comment.submitted_at) ||
          typeof comment.author_association !== 'string'
        )
          invalid();
        if (!own && !TRUSTED.has(comment.author_association) && comment.user.type !== 'Bot') continue;
        // PR feedback is context, not executable instructions. The agent fetches its current content itself.
        if (comment.body.trim())
          events.push({
            key: key(['comment', comment.node_id, comment.updated_at ?? comment.submitted_at]),
            text: own
              ? `New or edited inline review comment from your own account (a posted code review finding); comment id ${comment.node_id}.`
              : `New or edited review feedback from ${comment.user.login}; comment id ${comment.node_id}.`,
          });
      }
    }
  }
  return {
    url,
    title: pr.title,
    state: pr.state,
    head: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    pending,
    checksPassed,
    // what decides whether the user's click is the only merge it will get (src/lib/prInbox.ts)
    mergeable: pr.mergeable,
    mergeState: typeof pr.mergeStateStatus === 'string' ? pr.mergeStateStatus : 'UNKNOWN',
    landing:
      record(pr.autoMergeRequest) ||
      (Array.isArray(pr.labels) && pr.labels.some((/** @type {any} */ l) => record(l) && LANDING_LABELS.has(l.name))),
    failed: events.filter((e) => e.text.startsWith('Failing check:')).length,
    events,
  };
}

module.exports = { readPullRequest, classifyCheck, json, invalid, record, string };
