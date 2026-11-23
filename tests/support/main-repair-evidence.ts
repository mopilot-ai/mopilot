// Models source-repository first-parent history and official CI producers alongside the real claim Git Database fixture.
import { claimHub } from './claim-hub.ts';
import { posted } from './ciStatuses.ts';
export const RED = 'a'.repeat(40),
  FIX = 'b'.repeat(40),
  HEAD = 'c'.repeat(40),
  PRHEAD = 'd'.repeat(40);
export const NOW = Date.parse('2026-11-05T00:00:00Z');
export function repairEvidenceWorld() {
  const hub = claimHub(),
    repo = 'mopilot-ai/mopilot-internal',
    releaseRepo = 'mopilot-ai/mopilot-code-release',
    calls: string[][] = [];
  const state: any = {
    head: HEAD,
    parents: { [HEAD]: [FIX], [FIX]: [RED], [RED]: [] },
    statuses: { [RED]: [{ context: 'main-e2e', state: 'failure', target_url: `https://github.com/${releaseRepo}/actions/runs/8` }] },
    issue: {
      number: 5,
      state: 'open',
      title: 'Main is red: main-e2e',
      labels: [{ name: 'main-red' }],
      body: `<!-- main-red ${JSON.stringify({ context: 'main-e2e', sha: RED, files: ['tests/e2e/a.spec.ts'] })} -->`,
    },
    pull: { state: 'open', head: { sha: PRHEAD }, labels: [{ name: 'fixes-main' }], merged_at: null, merge_commit_sha: FIX },
    run: {
      id: 9,
      path: '.github/workflows/main-reverify.yml',
      display_title: 'Main reverify',
      status: 'in_progress',
      conclusion: null,
      created_at: new Date(NOW).toISOString(),
    },
    sweeps: [],
  };
  const gh = (args: string[]): string => {
    calls.push(args);
    const route = args.find((a) => a.startsWith('repos/'))!;
    if (route === `repos/${repo}/git/ref/heads/main`) return JSON.stringify({ object: { sha: state.head } });
    if (route === `repos/${repo}/issues?labels=main-red&state=open&per_page=100`) return JSON.stringify(state.open ?? [state.issue]);
    if (route === `repos/${repo}/issues/5`) return JSON.stringify(state.issue);
    if (route === `repos/${repo}/pulls/7`) return JSON.stringify(state.pull);
    if (route === `repos/${releaseRepo}/actions/runs/9`) return JSON.stringify(state.run);
    if (route.includes('/actions/workflows/sweep.yml/runs?')) return JSON.stringify({ workflow_runs: state.sweeps });
    const compare = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
    if (compare) {
      let at = compare[2];
      const seen = new Set<string>();
      while (at && !seen.has(at)) {
        seen.add(at);
        if (at === compare[1]) return at === compare[2] ? 'identical' : 'ahead';
        at = state.parents[at]?.[0];
      }
      return 'diverged';
    }
    const statuses = /\/commits\/(main|[a-f0-9]{40})\/(status|statuses\?per_page=100)$/.exec(route);
    if (statuses) {
      const rows = posted(state.statuses[statuses[1] === 'main' ? state.head : statuses[1]] ?? []);
      return JSON.stringify(statuses[2] === 'status' ? { statuses: rows } : rows);
    }
    const commit = /\/git\/commits\/([a-f0-9]{40})$/.exec(route);
    if (commit && state.parents[commit[1]]) return JSON.stringify({ parents: state.parents[commit[1]].map((sha: string) => ({ sha })) });
    return hub.gh(args);
  };
  const job = { repo, issue: 5, context: 'main-e2e', failedSha: RED, now: NOW, releaseRepo };
  return { hub, gh, repo, releaseRepo, calls, state, job };
}
