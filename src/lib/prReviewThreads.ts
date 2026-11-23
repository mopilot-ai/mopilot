// A pull request's review threads as the Changes pane shows them under their lines: GitHub's GraphQL answer read defensively, the PR a URL names, the order "Next unresolved comment" walks, and the request "Answer review comments" sends the chat.

export type ReviewComment = { id: string; author: string; body: string; url: string };
export type ReviewThread = {
  id: string;
  path: string;
  /** the line it sits on now (null: GitHub no longer places it, the code under it changed) */
  line: number | null;
  side: 'L' | 'R';
  resolved: boolean;
  outdated: boolean;
  comments: ReviewComment[];
};
export type PrRef = { owner: string; name: string; number: number };

/** What the pane reads of a PR: its head commit (a new comment is made on it) and its first 100 threads. */
export const REVIEW_THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'headRefOid reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line diffSide ' +
  'comments(first:30){pageInfo{hasNextPage} nodes{id author{login} body url}}}}}}}';

/** The owner, repository and number of a github.com pull request URL, or null for any other URL. */
export function prRef(url: string): PrRef | null {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : null;
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const text = (v: unknown) => (typeof v === 'string' ? v : null);

function commentOf(raw: unknown): ReviewComment | null {
  const c = record(raw);
  const id = text(c?.id);
  const body = text(c?.body);
  if (!c || !id || body === null) return null;
  return { id, author: text(record(c.author)?.login) ?? 'ghost', body, url: text(c.url) ?? '' };
}

function threadOf(raw: unknown): ReviewThread | null {
  const t = record(raw);
  const id = text(t?.id);
  const path = text(t?.path);
  if (!t || !id || !path) return null;
  const nodes = record(t.comments)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const comments = nodes.map(commentOf).filter((c): c is ReviewComment => !!c);
  if (!comments.length) return null;
  return {
    id,
    path,
    line: Number.isInteger(t.line) && (t.line as number) > 0 ? (t.line as number) : null,
    side: t.diffSide === 'LEFT' ? 'L' : 'R',
    resolved: t.isResolved === true,
    outdated: t.isOutdated === true,
    comments,
  };
}

/**
 * GitHub's answer to REVIEW_THREADS_QUERY: the PR's head commit and its threads with at least one readable comment,
 * a thread it can't read left out. An answer without the pull request (an error, a renamed repository) throws, so the
 * pane says the comments couldn't be read rather than that there are none.
 */
export function parseReviewThreads(json: unknown): { head: string | null; threads: ReviewThread[]; limited: boolean } {
  const pr = record(record(record(record(json)?.data)?.repository)?.pullRequest);
  if (!pr) throw new Error('GitHub did not send this pull request’s review comments');
  const connection = record(pr.reviewThreads);
  const nodes = connection?.nodes;
  if (!Array.isArray(nodes) || typeof record(connection?.pageInfo)?.hasNextPage !== 'boolean')
    throw new Error('GitHub sent incomplete review comments. Try again.');
  const threads = nodes.map(threadOf).filter((t): t is ReviewThread => !!t);
  const limited =
    record(connection?.pageInfo)?.hasNextPage === true ||
    threads.length !== nodes.length ||
    nodes.some((t) => record(record(record(t)?.comments)?.pageInfo)?.hasNextPage !== false);
  return { head: text(pr.headRefOid), threads, limited };
}

/** The unresolved threads in the order the pane shows them: by file, then by line (ones GitHub no longer places first). */
export function unresolvedOrder(threads: readonly ReviewThread[]): ReviewThread[] {
  return threads.filter((t) => !t.resolved).sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}

/** The unresolved thread after `current` (the first one when none is current, or it is gone), going round. */
export function nextUnresolved(threads: readonly ReviewThread[], current: string | null): ReviewThread | null {
  const order = unresolvedOrder(threads);
  if (!order.length) return null;
  const at = order.findIndex((t) => t.id === current);
  return order[(at + 1) % order.length];
}

/** What "Answer review comments" asks the chat, on every harness. */
export const answerReviewRequest = (pr: PrRef) =>
  `Read the unresolved review comments on ${pr.owner}/${pr.name}#${pr.number} and address each one: make the change, or reply with why not.`;
