// The repository a chat's folder pushes to (its origin remote), read once a minute at most per folder, and what a message's #N references link with.
import { useEffect, useMemo, useRef, useState } from 'react';
import { native } from './native';
import { knownRefs, repoFromRemote, type IssueRepo, type KnownRefs } from './issueRefs';

/** How long a folder's repository is reused before it is read again (a remote can be added to a folder later). */
export const CHAT_REPO_TTL_MS = 60_000;

const reads = new Map<string, { at: number; repo: Promise<IssueRepo | null> }>();

/** The repository `cwd` pushes to, or null (no folder, not a repository, no remote, an unknown host or a failed read). */
export function chatRepo(cwd: string | null | undefined, now = Date.now()): Promise<IssueRepo | null> {
  if (!cwd) return Promise.resolve(null);
  const cached = reads.get(cwd);
  if (cached && now - cached.at < CHAT_REPO_TTL_MS) return cached.repo;
  const repo = Promise.resolve()
    .then(() => native.git.info(cwd))
    .then(
      (info) => repoFromRemote(info?.remote),
      () => null,
    );
  reads.set(cwd, { at: now, repo });
  return repo;
}

/** Forgets every folder's repository (tests). */
export function resetChatRepos() {
  reads.clear();
}

/** The repository `cwd` pushes to, once read; null until then and for a folder without one. */
export function useChatRepo(cwd: string | null | undefined): IssueRepo | null {
  const [state, setState] = useState<{ cwd: string | null | undefined; repo: IssueRepo | null }>({ cwd, repo: null });
  useEffect(() => {
    let live = true;
    void chatRepo(cwd).then((repo) => {
      if (live) setState((s) => (s.cwd === cwd && sameRepo(s.repo, repo) ? s : { cwd, repo }));
    });
    return () => {
      live = false;
    };
  }, [cwd]);
  // a folder changed since the last read: its old repository is not this folder's
  return state.cwd === cwd ? state.repo : null;
}

const sameRepo = (a: IssueRepo | null, b: IssueRepo | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What remarkIssueRefs links a message's references with: the chat's repository and the numbers the whole message names
 * with theirs, so a bare #N in any run links to the same one. The same object until either changes, not each time the
 * text grows, so a streaming reply's closed runs are not parsed again.
 */
export function useIssueRefs(text: string, cwd: string | null | undefined): { repo: IssueRepo | null; known: KnownRefs } {
  const repo = useChatRepo(cwd);
  const last = useRef<{ key: string; value: { repo: IssueRepo | null; known: KnownRefs } } | null>(null);
  return useMemo(() => {
    const known = knownRefs(text, repo);
    const key = JSON.stringify([repo, [...known]]);
    if (last.current?.key !== key) last.current = { key, value: { repo, known } };
    return last.current.value;
  }, [text, repo]);
}
