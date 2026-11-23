// What a reference typed to start from a GitHub pull request names: `#12`, or a pull request's link (and so its repository).
import { pullRequestUrl } from './pullRequest.mjs';

/**
 * `{ number, repo }` for `#12` (repo null: the folder's own) or https://github.com/owner/name/pull/12 (also any of its
 * tabs, a commit in it or an anchor; repo lowercased), else null. A bare number is a branch search, never a pull request.
 * @param {unknown} text
 * @returns {{ number: number, repo: string | null } | null}
 */
export function pullRequestRef(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const short = /^#([1-9]\d{0,8})$/.exec(t);
  if (short) return { number: Number(short[1]), repo: null };
  const url = pullRequestUrl(t.replace(/^(https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/\d+)(?:[/?#].*)?$/, '$1'));
  const m = url && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url);
  return m && m[2].length <= 9 ? { number: Number(m[2]), repo: m[1] } : null;
}
