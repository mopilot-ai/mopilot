// Superagent S1 GitHub source, pure half: rate-limit/poll-interval header math and the normalization of GitHub payloads into one Superagent event.
//
// The event (exact shape the intake receives; no other fields):
//   {
//     source: 'github',
//     externalId: string,   // GitHub node id of the comment (or of the issue/PR for an 'opened' event): stable per real event, so a replay is a no-op downstream
//     threadKey: string,    // node id of the issue or PR the event belongs to (survives a repo rename)
//     kind: 'issue.opened' | 'pull_request.opened' | 'issue.comment' | 'pull_request.comment' | 'pull_request.review_comment',
//     actor: { login: string, id: number, type: string },  // type is GitHub's own: 'Bot' marks bots, 'User', 'Organization', ...
//     repo: { nodeId: string, fullName: string },
//     subject: { type: 'issue' | 'pull_request', nodeId: string, number: number, url: string },  // url is the html_url
//     body: string,         // raw GitHub text; the intake sanitizes it
//     occurredAt: string    // ISO-8601 time the comment / issue / PR was created
//   }

const API_BASE = 'https://api.github.com';
// A first poll looks back one hour, so a new install does not backfill months of notifications; after that our own high-water mark rules.
const INITIAL_WINDOW_MS = 60 * 60_000;
// The mark is kept this far behind the newest update seen, so an update stamped in the same second as it is not missed (repeats are dropped downstream).
const OVERLAP_MS = 1000;
const DEFAULT_POLL_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const SECONDARY_LIMIT_MS = 60_000;

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v.length > 0;

/** An ISO-8601 time in whole seconds, the form GitHub's `since` takes. */
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const isTime = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/**
 * Where this poll's window starts: our own mark from the last complete poll, else a short look-back from now.
 * Read state plays no part: GitHub's `last_read_at` and `unread` say what the person has seen, not what we have.
 */
function windowStart(cursor, nowMs) {
  return record(cursor) && isTime(cursor.since) ? cursor.since : isoSeconds(nowMs - INITIAL_WINDOW_MS);
}

/** The window start for the next poll once every notification of this one was handled: just behind the newest `updated_at` seen, never before the current start. */
function nextSince(start, notes) {
  let newest = -Infinity;
  for (const note of notes) if (record(note) && isTime(note.updated_at)) newest = Math.max(newest, Date.parse(note.updated_at));
  return Number.isFinite(newest) ? isoSeconds(Math.max(Date.parse(start), newest - OVERLAP_MS)) : start;
}

/** The notifications list of a repo: read ones too (the default is unread only), changed after `since`. */
const notificationsUrl = (repo, since) => `${API_BASE}/repos/${repo}/notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`;
/** The issue comments of an issue or PR changed after `since` (a PR's are served under its issue number, not under /pulls). */
const issueCommentsUrl = (subjectUrl, since) =>
  `${subjectUrl.replace(/\/pulls\/(\d+)$/, '/issues/$1')}/comments?per_page=100&since=${encodeURIComponent(since)}`;
/** Whether the issue or PR was created inside the window that starts at `since`. */
const openedSince = (issue, since) => record(issue) && isTime(issue.created_at) && Date.parse(issue.created_at) >= Date.parse(since);
/** A PR's review comments changed after `since`. */
const reviewsUrl = (subjectUrl, since) => `${subjectUrl}/comments?per_page=100&since=${encodeURIComponent(since)}`;

/** Seconds in a header value to ms, or null when absent or not a non-negative number. */
function seconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
}

/** The next poll delay GitHub asks for: X-Poll-Interval, never below the default minute. */
function pollIntervalMs(headers) {
  const asked = seconds(headers.get('x-poll-interval'));
  return asked === null ? null : Math.max(asked, DEFAULT_POLL_MS);
}

/** How long to wait after a 403/429: Retry-After, else the primary limit's reset time, else a secondary-limit minute that grows with `strikes`. */
function rateLimitDelayMs(headers, nowMs, strikes) {
  const retry = seconds(headers.get('retry-after'));
  if (retry !== null) return Math.min(Math.max(retry, 1000), MAX_BACKOFF_MS * 4);
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = seconds(headers.get('x-ratelimit-reset'));
    if (reset !== null) return Math.min(Math.max(reset - nowMs, 1000), MAX_BACKOFF_MS * 4);
  }
  return Math.min(SECONDARY_LIMIT_MS * 2 ** Math.max(strikes - 1, 0), MAX_BACKOFF_MS);
}

/** Exponential backoff for failures with no server hint (network, 5xx, auth). */
function failureDelayMs(baseMs, strikes) {
  return Math.min(baseMs * 2 ** Math.max(strikes - 1, 0), MAX_BACKOFF_MS);
}

/** The `rel="next"` URL of a Link header, if any. */
function nextLink(headers) {
  const link = headers.get('link');
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** True when the URL is on the GitHub API host, the only place the token is ever sent. */
function isApiUrl(url) {
  return typeof url === 'string' && (url === API_BASE || url.startsWith(`${API_BASE}/`));
}

const actorOf = (user) =>
  record(user) && str(user.login)
    ? { login: user.login, id: Number.isSafeInteger(user.id) ? user.id : 0, type: str(user.type) ? user.type : 'User' }
    : { login: 'ghost', id: 0, type: 'User' };

/** Whether this actor is the Superagent's own bot: its login with or without the `[bot]` suffix, case-insensitive. */
function isOwnActor(actor, ownLogin) {
  if (!str(ownLogin)) return false;
  const strip = (s) => s.toLowerCase().replace(/\[bot\]$/, '');
  return strip(actor.login) === strip(ownLogin);
}

/** The subject record of an issue or PR payload, or null when GitHub sent something incomplete. */
function subjectOf(issue, type) {
  if (!record(issue) || !str(issue.node_id) || !Number.isSafeInteger(issue.number) || !str(issue.html_url)) return null;
  return { type, nodeId: issue.node_id, number: issue.number, url: issue.html_url };
}

/** The repository of a notification, or null. */
function repoOf(repository) {
  return record(repository) && str(repository.node_id) && str(repository.full_name)
    ? { nodeId: repository.node_id, fullName: repository.full_name }
    : null;
}

/** Normalize one comment (issue comment or PR review comment) of `subject`; null when incomplete. */
function commentEvent(comment, subject, repo) {
  if (!record(comment) || !str(comment.node_id) || !str(comment.created_at)) return null;
  const review = typeof comment.url === 'string' && comment.url.includes('/pulls/comments/');
  const kind = review ? 'pull_request.review_comment' : subject.type === 'pull_request' ? 'pull_request.comment' : 'issue.comment';
  return {
    source: 'github',
    externalId: comment.node_id,
    threadKey: subject.nodeId,
    kind,
    actor: actorOf(comment.user),
    repo,
    subject,
    body: typeof comment.body === 'string' ? comment.body : '',
    occurredAt: comment.created_at,
  };
}

/** Normalize the issue or PR itself (a notification with no comment) into its 'opened' event; null when incomplete. */
function openedEvent(issue, subject, repo) {
  if (!record(issue) || !str(issue.created_at)) return null;
  return {
    source: 'github',
    externalId: subject.nodeId,
    threadKey: subject.nodeId,
    kind: subject.type === 'pull_request' ? 'pull_request.opened' : 'issue.opened',
    actor: actorOf(issue.user),
    repo,
    subject,
    body: typeof issue.body === 'string' ? issue.body : '',
    occurredAt: issue.created_at,
  };
}

/** GitHub's notification subject type to ours, or null for subjects the source ignores (checks, releases, commits...). */
function subjectType(type) {
  return type === 'Issue' ? 'issue' : type === 'PullRequest' ? 'pull_request' : null;
}

module.exports = {
  API_BASE,
  INITIAL_WINDOW_MS,
  OVERLAP_MS,
  isoSeconds,
  windowStart,
  nextSince,
  notificationsUrl,
  issueCommentsUrl,
  openedSince,
  reviewsUrl,
  DEFAULT_POLL_MS,
  pollIntervalMs,
  rateLimitDelayMs,
  failureDelayMs,
  nextLink,
  isApiUrl,
  isOwnActor,
  subjectOf,
  repoOf,
  commentEvent,
  openedEvent,
  subjectType,
};
