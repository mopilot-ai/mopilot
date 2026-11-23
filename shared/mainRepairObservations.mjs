// Accepts only trusted main CI failures and proves recovery of the assigned failure on main containing its fix.
import { readClaim } from './mainRedClaims.mjs';
import { mainRepairHistory } from './mainRepairHistory.mjs';
import { issueMarker } from './mainFailure.mjs';
import { liveRepairWait } from './mainRepairWait.mjs';
const CONTEXTS = new Set(['main-unit-tests', 'main-e2e']);
const RELEASE = 'mopilot-ai/mopilot-code-release';
const labelled = (issue) => Array.isArray(issue.labels) && issue.labels.some((l) => l.name === 'main-red');
const issueUrl = (repo, issue) => `https://github.com/${repo}/issues/${issue}`;
const failed = (state) => state === 'failure' || state === 'error';
const relation = (gh, repo, a, b) => gh(['api', `repos/${repo}/compare/${a}...${b}`, '--jq', '.status']).trim();
const contains = (gh, repo, a, b) => ['ahead', 'identical'].includes(relation(gh, repo, a, b));

function sweeps(gh, releaseRepo) {
  const data = JSON.parse(gh(['api', `repos/${releaseRepo}/actions/workflows/sweep.yml/runs?status=completed&per_page=20`]));
  if (!Array.isArray(data.workflow_runs)) throw new Error('Unreadable sweep runs');
  return data.workflow_runs.filter(
    (r) => r.path === '.github/workflows/sweep.yml' && ['success', 'failure', 'timed_out', 'startup_failure'].includes(r.conclusion),
  );
}

export function observeRepairs({ gh, repo, releaseRepo = RELEASE }) {
  const open = JSON.parse(gh(['api', `repos/${repo}/issues?labels=main-red&state=open&per_page=100`]));
  if (!Array.isArray(open) || open.length >= 100) throw new Error('Unreadable or incomplete main-red issues');
  const incidents = [];
  for (const issue of open) {
    if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !labelled(issue)) continue;
    const marker = issueMarker(issue.body);
    if (marker && CONTEXTS.has(marker.context) && issue.title === `Main is red: ${marker.context}`) {
      const history = mainRepairHistory(gh, repo),
        latest = history.latest(marker.context);
      if (!latest || latest.sha !== marker.sha || !failed(latest.state) || history.verification(marker.context, marker.sha)) continue;
      history.assertCurrent();
      incidents.push({
        issue: issue.number,
        context: marker.context,
        failedSha: marker.sha,
        url: issueUrl(repo, issue.number),
        runUrl: latest.url,
      });
    } else if (issue.title === 'Main is red: sweep') {
      const runs = sweeps(gh, releaseRepo);
      if (
        runs.length < 2 ||
        runs.slice(0, 2).some((r) => r.conclusion === 'success') ||
        !/^[0-9a-f]{40}$/.test(runs[0].head_sha) ||
        !Number.isSafeInteger(runs[0].id)
      )
        continue;
      incidents.push({
        issue: issue.number,
        context: 'sweep',
        failedSha: runs[0].head_sha,
        url: issueUrl(repo, issue.number),
        runUrl: `https://github.com/${releaseRepo}/actions/runs/${runs[0].id}`,
      });
    }
  }
  return incidents;
}

export function inspectRepair({
  gh,
  repo,
  issue,
  failedSha,
  context,
  pr: knownPr = /** @type {number | null} */ (null),
  now = Date.now(),
  releaseRepo = RELEASE,
}) {
  const claim = readClaim({ gh, repo, issue }),
    pr = claim.state === 'claimed' ? (claim.pr ?? knownPr) : knownPr;
  const record = JSON.parse(gh(['api', `repos/${repo}/issues/${issue}`]));
  const pull = pr ? JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}`])) : null;
  const merged = !!pull?.merged_at && /^[0-9a-f]{40}$/.test(pull.merge_commit_sha ?? '');
  const history = mainRepairHistory(gh, repo);
  const fixContained = merged && contains(gh, repo, pull.merge_commit_sha, history.head);
  const latest = CONTEXTS.has(context) ? history.latest(context) : null;
  let recovered = false;
  if (context === 'sweep') {
    const latest = sweeps(gh, releaseRepo)[0];
    recovered = !!(fixContained && latest?.conclusion === 'success' && Date.parse(latest.created_at) >= Date.parse(pull.merged_at));
  } else if (CONTEXTS.has(context)) {
    recovered = !!(fixContained && latest?.state === 'success' && contains(gh, repo, pull.merge_commit_sha, latest.sha));
    if (fixContained && !recovered) {
      const proof = history.verification(context, failedSha);
      recovered = !!(proof && contains(gh, repo, pull.merge_commit_sha, proof.sha));
    }
  }
  history.assertCurrent();
  const marker = issueMarker(record.body);
  const superseded =
    context === 'sweep'
      ? record.title !== 'Main is red: sweep'
      : !marker || marker.context !== context || (!merged && (record.state === 'closed' || latest?.state === 'success'));
  const liveCI = !recovered && claim.state === 'claimed' && liveRepairWait({ gh, repo, claim, context, now, releaseRepo });
  return { claim, pr: pr ?? null, merged, recovered, superseded, liveCI };
}
