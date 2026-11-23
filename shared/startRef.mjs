// What a reference typed to start a chat names: `#12` (a GitHub pull request, else an issue, of the folder's own repository), a pull request's or an issue's GitHub link, or a Linear issue (ENG-12, or its linear.app link).
import { pullRequestRef } from './pullRequestRef.mjs';

const ISSUE_LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d{0,8})(?:[/?#].*)?$/i;
/** A Linear issue key: the team's key (upper case letters and digits) and the issue's number. */
const LINEAR_KEY = /^([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,7})$/;
const LINEAR_LINK = /^https:\/\/linear\.app\/[\w.-]+\/issue\/([A-Z][A-Z0-9]{1,9}-[1-9]\d{0,7})(?:[/?#].*)?$/;

/**
 * `{ key }` for a Linear issue's key (ENG-12) or its linear.app link, else null. A key is upper case, as Linear shows
 * it, so a branch named eng-12 is still a branch.
 * @param {unknown} text
 * @returns {{ key: string } | null}
 */
export function linearRef(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (LINEAR_KEY.test(t)) return { key: t };
  const m = LINEAR_LINK.exec(t);
  return m ? { key: m[1] } : null;
}

/**
 * `{ number, repo, kind }`: `kind` 'pull' for a pull request's link, 'issue' for an issue's, null for `#12` (GitHub
 * numbers both in one series, so it is whichever the repository has); repo lowercased, null for `#12`. A Linear issue
 * is `{ kind: 'linear', key }`. Else null.
 * @param {unknown} text
 * @returns {{ number: number, repo: string | null, kind: 'pull' | 'issue' | null } | { kind: 'linear', key: string } | null}
 */
export function startRef(text) {
  const pr = pullRequestRef(text);
  if (pr) return { ...pr, kind: pr.repo ? 'pull' : null };
  const m = typeof text === 'string' ? ISSUE_LINK.exec(text.trim()) : null;
  if (m) return { number: Number(m[2]), repo: m[1].toLowerCase(), kind: 'issue' };
  const linear = linearRef(text);
  return linear ? { kind: 'linear', key: linear.key } : null;
}
