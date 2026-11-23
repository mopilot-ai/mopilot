// Finds live repair verification on older main commits too, so fast feature merges do not expire a genuine CI wait.
import { liveRepairCheck } from './mainRepairLease.mjs';
import { MAIN_LOOKBACK } from './mainRuns.mjs';
export function liveRepairWait(options) {
  const { repo, claim } = options,
    cache = new Map();
  const gh = (args) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, options.gh(args));
    return cache.get(key);
  };
  if (liveRepairCheck({ ...options, gh })) return true;
  if (!claim.pr) return false;
  const pull = JSON.parse(gh(['api', `repos/${repo}/pulls/${claim.pr}`]));
  if (!pull.merged_at || !/^[0-9a-f]{40}$/.test(pull.merge_commit_sha ?? '')) return false;
  const head = JSON.parse(gh(['api', `repos/${repo}/git/ref/heads/main`])).object?.sha;
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Unreadable main verification head');
  let at = head;
  for (let i = 0; at && i < MAIN_LOOKBACK; i++) {
    const relation = gh(['api', `repos/${repo}/compare/${pull.merge_commit_sha}...${at}`, '--jq', '.status']).trim();
    if (!['ahead', 'identical'].includes(relation)) return false;
    if (liveRepairCheck({ ...options, gh, target: at })) return true;
    if (at === pull.merge_commit_sha) return false;
    const commit = JSON.parse(gh(['api', `repos/${repo}/git/commits/${at}`]));
    if (!Array.isArray(commit.parents)) throw new Error('Unreadable main verification ancestry');
    at = commit.parents[0]?.sha;
    if (at && !/^[0-9a-f]{40}$/.test(at)) throw new Error('Unreadable main verification parent');
  }
  return false;
}
