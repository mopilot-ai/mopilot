// The session rail's local Git reads, with branch-scoped diff and pull request snapshots.
import { useCallback, useRef, useState } from 'react';
import { pullRequestUrl } from '../../../shared/pullRequest.mjs';
import type { useLocalFolder } from '../../lib/chatMachine';
import { diffTotals } from '../../lib/diff';
import { useEffectOn } from '../../lib/effects';
import { gitPoll } from '../../lib/gitPoll';
import { ignoring } from '../../lib/ignored';
import { native, type GitInfo } from '../../lib/native';
import { checkoutPullRequest } from '../../lib/pullRequestSources';
import { repositoryDiffFiles } from '../../lib/repositoryChanges';
import { visiblePoll } from '../../lib/visiblePoll';
import type { BranchPrLookup } from './PullRequestRow';
import type { BranchTotals } from './SummaryChanges';

const NO_BRANCH_PR = /^no pull requests? (?:found|associated)\b/im;

export function useLocalSummaryRepo(location: ReturnType<typeof useLocalFolder>, turn: unknown, running: boolean) {
  const cwd = location.pending || location.machine ? '' : location.cwd;
  const [checkout, setCheckout] = useState<{ version: number; git: GitInfo; unavailable?: true } | null>(null);
  const [totals, setTotals] = useState<BranchTotals | null>(null);
  const [failed, setFailed] = useState(false);
  const [pr, setPr] = useState<BranchPrLookup>();
  const refreshRequest = useRef(0);
  const prRequest = useRef(0);
  const currentRepo = useRef<{ key: string | null; version: number }>({ key: null, version: 0 });
  const needsPr = useRef(false);
  const [shownCwd, setShownCwd] = useState(cwd);
  if (shownCwd !== cwd) {
    setShownCwd(cwd);
    setCheckout(null);
    setTotals(null);
    setFailed(false);
    setPr(undefined);
  }

  const refresh = useCallback(
    async (includePr = true) => {
      if (!cwd) return;
      const request = ++refreshRequest.current;
      if (includePr) {
        prRequest.current++;
        needsPr.current = true;
      }
      let g: GitInfo | null | undefined;
      try {
        g = await native.git.info(cwd);
      } catch (error) {
        ignoring('read the checkout')(error);
      }
      if (request !== refreshRequest.current) return;
      if (!g) {
        // An unreadable checkout can return null. Keep any open draft and pause its repository actions.
        prRequest.current++;
        needsPr.current = true;
        setCheckout((last) => last && { ...last, unavailable: true });
        setTotals(null);
        setFailed(g === undefined);
        return;
      }

      const key = JSON.stringify([cwd, g.root, g.branch, g.remote]);
      if (key !== currentRepo.current.key) {
        // A checkout can leave and return before React paints either transition.
        currentRepo.current = { key, version: currentRepo.current.version + 1 };
        needsPr.current = true;
        setTotals(null);
        setPr(undefined);
      }
      setCheckout({ version: currentRepo.current.version, git: g });
      setFailed(false);

      const diff = repositoryDiffFiles(native.git, cwd, 'branch').then(
        (files) => {
          if (request === refreshRequest.current) setTotals({ files: files.length, ...diffTotals(files) });
        },
        () => {
          if (request !== refreshRequest.current) return;
          setTotals(null);
          setFailed(true);
        },
      );
      if (!needsPr.current || !g.remote) return diff;
      needsPr.current = false;
      const owner = currentRepo.current;
      const prRead = prRequest.current;
      const current = () => prRead === prRequest.current && currentRepo.current === owner;
      try {
        // the branch's PR where gh finds it, or where the branch is pushed when gh cannot (a deleted origin)
        const r = await checkoutPullRequest(cwd, 'number,url,title,state', {
          gh: (c, a) => native.git.gh(c, a),
          git: (c, a) => native.git.run(c, a),
        });
        if (current()) {
          if (r.ok) {
            const result = JSON.parse(r.stdout);
            const url = pullRequestUrl(result?.url);
            if (
              !Number.isSafeInteger(result?.number) ||
              !url ||
              typeof result.title !== 'string' ||
              !result.title.trim() ||
              !['OPEN', 'MERGED', 'CLOSED'].includes(result.state) ||
              !url.endsWith(`/pull/${result.number}`)
            ) {
              throw new Error('GitHub sent incomplete pull request details.');
            }
            setPr({ ...result, url });
          } else if (NO_BRANCH_PR.test(r.stderr)) {
            setPr(null);
          } else {
            throw new Error(r.stderr || 'GitHub CLI did not answer.');
          }
        }
      } catch (error) {
        // A failed read leaves the most recent result for this checkout in place.
        ignoring('read the branch pull request')(error);
        if (current()) setPr((last) => (last === undefined ? 'unavailable' : last));
      }
      await diff;
    },
    [cwd],
  );
  useEffectOn([refresh, turn, running], () => {
    if (!cwd) return;
    void refresh();
    const [key, ms] = gitPoll('summary-panel', running);
    const stopPoll = visiblePoll(key, ms, () => void refresh(false), { wake: false });
    const stopWake = visiblePoll('summary-panel-wake', Infinity, () => void refresh());
    return () => {
      refreshRequest.current++;
      prRequest.current++;
      stopPoll();
      stopWake();
    };
  });
  const git = checkout?.unavailable ? null : (checkout?.git ?? null);
  return { git, checkoutVersion: checkout?.version ?? null, totals, failed, pr, refresh };
}
