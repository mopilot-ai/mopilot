// A pull request's state as its icon, wherever one is listed (a message's link, the sidebar badge, the PR inbox).
import type { ThreadPullRequest } from '../../lib/threadPullRequest';
import { GitPullRequest, GitPullRequestDraft, GitPullRequestClosed, GitMerge } from '../ui/icons';

/** The icon for a PR's state. */
export function PullRequestIcon({ state, size = 16 }: { state: ThreadPullRequest['state']; size?: number }) {
  const Icon =
    state === 'merged' ? GitMerge : state === 'closed' ? GitPullRequestClosed : state === 'draft' ? GitPullRequestDraft : GitPullRequest;
  return <Icon size={size} />;
}
