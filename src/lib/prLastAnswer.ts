// Each PR's last full answer from GitHub, for the whole window (usePrInbox.ts): a read that failed, or whose merge-gate
// words couldn't be read, keeps the last one instead of turning the row into "Status unavailable", and an inbox that
// mounts later (a sidebar row scrolled back into view) starts from it instead of from nothing.
import type { ThreadPullRequest } from './threadPullRequest';

export const lastAnswers = new Map<string, ThreadPullRequest>();

/** Each chat's last listed PRs, so a list that mounts later starts from them instead of counting up from nothing. */
export const lastListed = new Map<string, ThreadPullRequest[]>();

/** An answer that says nothing new: GitHub couldn't be read, or the gate's words couldn't. */
const unread = (pr: ThreadPullRequest | null) => !pr || pr.state === 'unknown' || !!pr.details?.gateUnread;

/** The PR to show: this read's answer, or the last full one when this read failed. */
export function lastGood(
  url: string,
  pr: ThreadPullRequest | null,
  good: Map<string, ThreadPullRequest> = lastAnswers,
): ThreadPullRequest | null {
  if (!unread(pr)) {
    good.set(url, pr!);
    return pr;
  }
  return good.get(url) ?? pr;
}
