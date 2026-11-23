// Reads a bounded first-parent main snapshot, preserving trusted finished results and refusing truncated evidence.
import { MAIN_LOOKBACK, newestFinishedRuns, statusHistory, finishedStatus, reverifyContext, reverifyOf } from './mainRuns.mjs';
import { isScoped } from './mainFailure.mjs';
export function mainRepairHistory(gh, repo) {
  const head = JSON.parse(gh(['api', `repos/${repo}/git/ref/heads/main`])).object?.sha;
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Unreadable main head');
  const seen = [],
    cache = new Map();
  const read = (sha) => {
    if (!cache.has(sha)) {
      const result = statusHistory(JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/statuses?per_page=100`])), sha);
      if (result.length >= 100) throw new Error('Incomplete main status history');
      cache.set(sha, result);
    }
    return cache.get(sha);
  };
  function* commits() {
    let at = head;
    for (let i = 0; at && i < MAIN_LOOKBACK; i++) {
      seen.push(at);
      yield at;
      const c = JSON.parse(gh(['api', `repos/${repo}/git/commits/${at}`]));
      if (!Array.isArray(c.parents)) throw new Error('Unreadable main ancestry');
      at = c.parents[0]?.sha;
      if (at && !/^[0-9a-f]{40}$/.test(at)) throw new Error('Unreadable main parent');
    }
  }
  return {
    head,
    seen,
    read,
    latest(context) {
      return newestFinishedRuns({
        commits: commits(),
        read: (sha) =>
          read(sha).filter((s) => !(context === 'main-e2e' && s.context === context && s.state === 'success' && isScoped(s.description))),
        contexts: [context],
      })[context];
    },
    verification(context, red) {
      for (const sha of commits()) {
        if (sha === red) break;
        const s = finishedStatus(
          read(sha).filter((s) => s.description?.includes(reverifyOf(red))),
          reverifyContext(context),
        );
        if (s) return s.state === 'success' ? { sha, url: s.target_url ?? '' } : null;
      }
      return null;
    },
    assertCurrent() {
      if (JSON.parse(gh(['api', `repos/${repo}/git/ref/heads/main`])).object?.sha !== head)
        throw new Error('Main changed while reading repair evidence');
    },
  };
}
