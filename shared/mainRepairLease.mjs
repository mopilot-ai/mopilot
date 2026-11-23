// Keeps a repair lease for a genuinely live matching CI run, with an absolute run-age bound instead of trusting stale pending text.
export const MAX_CI_WAIT_MS = 3 * 60 * 60_000;
const LIVE = new Set(['queued', 'waiting', 'pending', 'requested', 'in_progress']);

export function liveRepairCheck({
  gh,
  repo,
  claim,
  context,
  now,
  target: selected = 'main',
  releaseRepo = 'mopilot-ai/mopilot-code-release',
}) {
  if (!claim.pr) return false;
  const pull = JSON.parse(gh(['api', `repos/${repo}/pulls/${claim.pr}`]));
  if (!pull || !pull.head?.sha || typeof pull.state !== 'string') throw new Error('Unreadable repair pull request');
  if (pull.state === 'closed' && !pull.merged_at) return false;
  const verifying = Boolean(pull.merged_at);
  const target = verifying ? selected : pull.head.sha;
  const response = JSON.parse(gh(['api', `repos/${repo}/commits/${target}/status`]));
  if (!Array.isArray(response?.statuses)) throw new Error('Unreadable repair CI status');
  const contexts = verifying ? new Set([context, `${context}-reverify`]) : new Set(['unit-tests', 'e2e-specs', 'e2e-specs-mac']);
  const latest = new Map();
  for (const status of response.statuses) {
    if (!status || typeof status.context !== 'string' || typeof status.state !== 'string') throw new Error('Unreadable repair CI status');
    if (!latest.has(status.context)) latest.set(status.context, status);
  }
  for (const status of latest.values()) {
    if (status.state !== 'pending' || !contexts.has(status.context)) continue;
    const runUrl = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:[/?#]|$)/.exec(status.target_url ?? '');
    if (!runUrl || runUrl[1] !== releaseRepo) continue;
    const run = JSON.parse(gh(['api', `repos/${releaseRepo}/actions/runs/${runUrl[2]}`]));
    if (!run || String(run.id) !== runUrl[2] || typeof run.status !== 'string') throw new Error('Unreadable repair CI run');
    const age = now - Date.parse(run.created_at);
    const unitTitle = `Unit tests for pull request ${claim.pr}`;
    const suffix =
      typeof run.display_title === 'string' && run.display_title.startsWith(unitTitle) ? run.display_title.slice(unitTitle.length) : null;
    const unit =
      run.path === '.github/workflows/pr-unit-tests.yml' &&
      typeof suffix === 'string' &&
      (suffix === '' || /^ \((?:GitHub fallback|audit) of [1-9]\d*\)$/.test(suffix));
    const e2eTitle = `E2E specs for pull request ${claim.pr} at ${pull.head.sha} merged with main `;
    const e2e =
      run.path === '.github/workflows/pr-e2e.yml' &&
      typeof run.display_title === 'string' &&
      run.display_title.startsWith(e2eTitle) &&
      /^[0-9a-f]{40}$/.test(run.display_title.slice(e2eTitle.length));
    const matching = verifying
      ? /^\.github\/workflows\/(?:main-validation|main-unit-tests|main-e2e|main-reverify)\.yml$/.test(run.path)
      : status.context === 'unit-tests'
        ? unit
        : e2e;
    if (matching && LIVE.has(run.status) && !run.conclusion && Number.isFinite(age) && age >= 0 && age <= MAX_CI_WAIT_MS) return true;
  }
  return false;
}
