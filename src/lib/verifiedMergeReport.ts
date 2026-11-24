// A commit-bearing delivery report identifies its PR only after GitHub confirms the matching merge.
import type { ThreadPullRequest } from './threadPullRequest';

export interface MergeCandidate {
  url: string;
  commit: string;
}

const VERIFIED_MERGE =
  /^(?:I|we) (?:verified|confirmed) (?:that )?(?:the )?merge commit ([a-f\d]{7,64})(?: and the snapshot)? (?:is|was|are) (?:on|in) (?:remote )?(?:main|master)\.$/i;

export function parseMergeCandidate(verification: string, label: string, url: string): MergeCandidate | undefined {
  const number = /^(?:(?:OSS|public|internal) )?(?:PR|pull request) #(\d+)$/i.exec(label)?.[1];
  if (!number || !url.endsWith('/' + number)) return;
  const commit = VERIFIED_MERGE.exec(verification.replace(/\x60/g, '').trim())?.[1];
  if (commit) return { url, commit: commit.toLowerCase() };
}

export function githubMergeOid(oid: unknown): string | undefined {
  if (typeof oid === 'string' && /^(?:[\da-f]{40}|[\da-f]{64})$/i.test(oid)) return oid.toLowerCase();
}

interface MergeReportScope {
  withdrawal?: string;
  urls: ReadonlySet<string>;
  mergeCandidate?: MergeCandidate;
}

export function withdrawsMerge({ withdrawal, urls }: MergeReportScope, url: string): boolean {
  if (withdrawal === undefined || (urls.size && !urls.has(url))) return false;
  return withdrawal === '' || url.endsWith('/' + withdrawal);
}

function removeWithdrawn(candidates: MergeCandidate[], scope: MergeReportScope) {
  for (let index = candidates.length - 1; index >= 0; index--) {
    if (withdrawsMerge(scope, candidates[index].url)) candidates.splice(index, 1);
  }
}

export function addMergeCandidates(candidates: MergeCandidate[], scopes: readonly MergeReportScope[]): void {
  const reply: MergeCandidate[] = [];
  for (const scope of scopes) {
    if (scope.mergeCandidate) reply.push(scope.mergeCandidate);
    if (scope.withdrawal === undefined) continue;
    removeWithdrawn(reply, scope);
    if (scope.withdrawal || scope.urls.size) removeWithdrawn(candidates, scope);
  }
  candidates.push(...reply);
}

/** One remaining URL can carry a scoped lifecycle report beside commit-verified delivery links. */
export function mixedReportUrl(urls: ReadonlySet<string>, scopes: readonly MergeReportScope[]): string | undefined {
  const remaining = new Set(urls);
  for (const { mergeCandidate } of scopes) {
    if (mergeCandidate) remaining.delete(mergeCandidate.url);
  }
  if (remaining.size === 1) return remaining.values().next().value;
}

export async function findVerifiedMergeUrls(
  candidates: MergeCandidate[],
  knownUrls: readonly string[],
  limit: number,
  lookup: (url: string) => Promise<ThreadPullRequest | null>,
  mergeCommits: WeakMap<ThreadPullRequest, string>,
): Promise<string[]> {
  const known = new Set(knownUrls);
  const remaining = limit - known.size;
  if (remaining <= 0) return [];
  const byUrl = new Map<string, Set<string>>();
  for (const { url, commit } of [...candidates].reverse()) {
    if (known.has(url)) continue;
    const commits = byUrl.get(url) ?? new Set<string>();
    commits.add(commit);
    byUrl.set(url, commits);
  }
  const verified = await Promise.all(
    [...byUrl].slice(0, remaining).map(async ([url, commits]) => {
      const pr = await lookup(url);
      if (pr?.state !== 'merged') return null;
      const oid = mergeCommits.get(pr);
      return oid && [...commits].some((commit) => oid.startsWith(commit)) ? url : null;
    }),
  );
  return verified.filter((url) => url !== null);
}
