// The app's one pull request reader: a chat's PR for its sidebar badge and one PR's status for a message's PR link, sharing one cache and GitHub limit.

import { native } from '../lib/native';
import { anyChatLoading, createPullRequestReader, savedReplies } from '../lib/threadPullRequest';
import { codexApi } from '../harness/adapters/codexApi';
import { hasThreadPullRequest } from '../harness/types';
import { useStore } from '../store/core';
import { nativeOf } from '../store/chats';
import { windowIsReady } from '../lib/windowReady';
import { GATE_STATUS } from '../lib/pullRequestIndicator';
import { machineFolderOf } from '../lib/machineFolder';
import { machineBranch } from '../lib/machinePullRequest';
import { checkoutPullRequest, firstPullRequest, listArgs, type GhAnswer } from '../lib/pullRequestSources';

/** The fields a PR read takes from `gh`, whether it finds the PR by its link, by its checkout or by its repository and branch. */
const PR_FIELDS =
  'url,state,isDraft,title,mergeable,mergeStateStatus,statusCheckRollup,additions,deletions,labels,autoMergeRequest,mergedAt,mergeCommit,headRefOid,reviewRequests';

/** The PR of a branch on a machine, looked up by this Mac's own `gh` where its Host says it may be (`origin`'s repository, then the one it is pushed to): the first PR found, or `null` for a branch with none. */
async function machinePullRequest(cwd: string): Promise<GhAnswer> {
  const source = await machineBranch(cwd);
  if (!source) return { ok: true, stdout: 'null' };
  return firstPullRequest(source.sources, (s) => native.git.gh(useStore.getState().home, listArgs(s, PR_FIELDS)));
}

// Main reads normalized history across all segments, including chats without an open window; read again only when the chat changed.
// A badge's read waits while any chat is being opened: the click's own read comes first. What it found is saved in main
// across launches, so a launch reads no unchanged chat's history for its badge.
const saved = savedReplies(async (id) => (await native.peer.referenceHistory([id], true))[id]?.turns ?? [], {
  opening: () => anyChatLoading(useStore.getState().runtime),
  store: {
    get: async (id, version) => native.pullRequests.savedReplies(id, version),
    put: async (id, version, replies) => native.pullRequests.saveReplies(id, version, replies),
  },
});

export const readPullRequest = createPullRequestReader({
  responses: async (id, version) => {
    const runtime = useStore.getState().runtime?.[id];
    if (runtime?.loaded) return runtime.turns;
    return saved(id, version);
  },
  attachments: (id, cursor) =>
    hasThreadPullRequest(nativeOf(id)) ? codexApi.threadAttachments(id, cursor) : Promise.resolve({ data: [], nextCursor: null }),
  legacy: async () => {
    const { codexHome } = await native.fs.configRoots();
    return native.fs.readText(`${codexHome}/.codex-global-state.json`);
  },
  // main refuses a window that hasn't said it is ready: until then the badge goes by the chat's other sources, and its
  // next read (a chat update, the minute's poll) reads the binding; waiting here instead held every row's read
  monitored: async (id) => (windowIsReady() ? ((await native.prMonitor.snapshot(id))?.url ?? null) : null),
  head: async (cwd) => {
    // a chat's folder on a machine: its Host says the branch
    if (machineFolderOf(cwd)) return (await machineBranch(cwd))?.branch ?? null;
    const result = await native.git.run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return result.ok ? result.stdout.trim() || null : null;
  },
  viewer: async () => {
    const r = await native.git.gh(useStore.getState().home, ['api', 'user', '--jq', '.login']);
    return (r.ok && r.stdout.trim()) || null;
  },
  gateStatus: async (url, head) => {
    const [, owner, repo] = new URL(url).pathname.split('/');
    const r = await native.git.gh(useStore.getState().home, [
      'api',
      `repos/${owner}/${repo}/commits/${head}/statuses`,
      '--jq',
      `[.[] | select(.context == "${GATE_STATUS}")][0]`,
    ]);
    // a failed read is not "no status": the reader marks the PR's gate unread
    if (!r.ok) throw new Error(`gh could not read the commit statuses: ${r.stderr}`);
    const status = JSON.parse(r.stdout || 'null');
    return status && typeof status === 'object' ? status : null;
  },
  // Explicit URL works even when the chat's old worktree has been deleted.
  gh: (url, cwd) =>
    url
      ? native.git.gh(useStore.getState().home, ['pr', 'view', '--json', PR_FIELDS, '--', url])
      : machineFolderOf(cwd)
        ? machinePullRequest(cwd)
        : checkoutPullRequest(cwd, PR_FIELDS, { gh: (c, a) => native.git.gh(c, a), git: (c, a) => native.git.run(c, a) }),
});
