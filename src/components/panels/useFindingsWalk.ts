// The review findings the Changes pane walks for one chat: the walk, its review's state, the findings still to act on and the one in focus.

import { useMemo } from 'react';
import { latestReviewId, leftToActOn, reviewState } from '../../lib/reviewState';
import { useStore } from '../../store/core';

/**
 * The walk of chat `chatId` (another chat's walk is none here), its review with each finding's status, the findings still
 * to act on (not dismissed in the diff, nor fixed or settled by a re-report), the one in focus (the first shown when the
 * walk's own left), and whether the review is still the chat's latest (a newer review supersedes it). The strip and the
 * line notes read the same walk through this.
 */
export function useFindingsWalk(chatId: string | null) {
  const panelWalk = useStore((s) => s.diffPanel.walk);
  const walk = panelWalk && panelWalk.chatId === chatId ? panelWalk : null;
  const turns = useStore((s) => (walk ? s.runtime[walk.chatId]?.turns : undefined));
  const marks = useStore((s) => (walk ? s.reviewMarks[walk.chatId]?.[walk.reviewId] : undefined));
  return useMemo(() => {
    const review = walk ? reviewState(turns, walk.reviewId, marks) : null;
    const shown = review ? review.statuses.flatMap((st, i) => (leftToActOn(st) ? [i] : [])) : [];
    const current = walk && shown.includes(walk.current) ? walk.current : (shown[0] ?? null);
    const latest = !!walk && latestReviewId(turns) === walk.reviewId;
    return { walk, review, shown, current, latest };
  }, [walk, turns, marks]);
}
