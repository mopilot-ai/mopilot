// The Changes pane's GitHub calls for review comments, through the user's gh in the folder: the open pull request of the folder's branch, its review threads, and a new comment on a line of it.

import { native } from './native';
import { errorText } from './ignored';
import { sameReviewLines } from './diffReview';
import { parseUnifiedDiff, type DiffFile } from './diff';
import { REVIEW_THREADS_QUERY, parseReviewThreads, prRef, type PrRef, type ReviewThread } from './prReviewThreads';
import type { DiffCommentRange } from '../../shared/diffComments.mjs';

export type BranchReview = { pr: PrRef & { url: string }; head: string | null; threads: ReviewThread[]; limited: boolean };

async function gh(cwd: string, args: string[]): Promise<string> {
  const r = await native.git.gh(cwd, args);
  if (!r.ok) throw new Error(r.stderr.split('\n')[0] || 'gh failed');
  return r.stdout;
}

/**
 * The open pull request of `cwd`'s branch with its review threads, or null when the branch has none open (no PR,
 * merged or closed, not a GitHub repository). A failure to read the threads of an open one rejects.
 */
export async function readBranchReview(cwd: string): Promise<BranchReview | null> {
  let view: { url?: unknown; state?: unknown };
  try {
    view = JSON.parse(await gh(cwd, ['pr', 'view', '--json', 'url,state']));
  } catch (error) {
    if (
      /no pull requests found|no pull request associated|not a git repository|no git remotes|none of the git remotes.*GitHub/i.test(
        errorText(error),
      )
    )
      return null;
    throw error;
  }
  const url = typeof view?.url === 'string' ? view.url : '';
  const ref = prRef(url);
  if (!ref || !['OPEN', 'MERGED', 'CLOSED'].includes(String(view.state)))
    throw new Error('GitHub sent incomplete pull request details. Try again.');
  if (view.state !== 'OPEN') return null;
  const args = ['api', 'graphql', '-f', `query=${REVIEW_THREADS_QUERY}`, '-f', `owner=${ref.owner}`, '-f', `name=${ref.name}`];
  const result = parseReviewThreads(JSON.parse(await gh(cwd, [...args, '-F', `number=${ref.number}`])));
  return { pr: { ...ref, url }, ...result };
}

/**
 * Post `body` as a review comment on `range` of the PR at `head` (its lines on GitHub's side of them). Rejects with
 * gh's reason; nothing is retried.
 */
export async function postReviewComment(
  cwd: string,
  review: BranchReview,
  range: DiffCommentRange,
  body: string,
  expected: DiffFile,
  isCurrent: () => boolean,
): Promise<void> {
  if (!review.head) throw new Error('GitHub did not say which commit the pull request is at');
  const [local, status, latest, patch] = await Promise.all([
    native.git.run(cwd, ['rev-parse', 'HEAD']),
    native.git.status(cwd, true),
    gh(cwd, ['pr', 'view', review.pr.url, '--json', 'headRefOid,state']),
    gh(cwd, ['pr', 'diff', review.pr.url, '--color=never']),
  ]);
  const remote = JSON.parse(latest);
  const file = parseUnifiedDiff(patch).find((f) => f.path === range.path);
  if (!isCurrent()) throw new Error('This review changed. Open the comment again.');
  if (
    !status ||
    !local.ok ||
    local.stdout.trim() !== review.head ||
    remote?.headRefOid !== review.head ||
    remote?.state !== 'OPEN' ||
    status.files.some((f) => f.path === range.path) ||
    !file ||
    !sameReviewLines(expected, file, range)
  )
    throw new Error('These lines differ from the pull request. Refresh the review and push or save your changes before commenting.');
  const side = (s: 'L' | 'R') => (s === 'L' ? 'LEFT' : 'RIGHT');
  const { owner, name, number } = review.pr;
  const args = ['api', `repos/${owner}/${name}/pulls/${number}/comments`, '-f', `body=${body}`, '-f', `commit_id=${review.head}`];
  args.push('-f', `path=${range.path}`, '-F', `line=${range.endLine}`, '-f', `side=${side(range.endSide)}`);
  if (range.startLine !== range.endLine || range.startSide !== range.endSide)
    args.push('-F', `start_line=${range.startLine}`, '-f', `start_side=${side(range.startSide)}`);
  await gh(cwd, args);
}
