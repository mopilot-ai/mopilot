// The centered pill row above the composer, with the chat's goal, and the owner of its PR inbox, which draws no row.
import { lazy, Suspense, useState } from 'react';
import { useSession } from '../../store/session/useSession';
import { GoalPill, goalShown } from './GoalBar';

// loaded on first use: the inbox reads the chat's sessions and PRs, which a read-only thread never shows
const PrInboxOwner = lazy(() => import('./PrInbox').then((m) => ({ default: m.PrInboxOwner })));

export function ComposerPills({
  threadId,
  showGoal,
  showInbox = false,
}: {
  threadId: string;
  /** the view shows the chat's goal (not a read-only sub-agent thread) */
  showGoal: boolean;
  /** the view can act on the chat's sessions and PRs (not a read-only thread) */
  showInbox?: boolean;
}) {
  const s = useSession(threadId);
  const goal = showGoal && goalShown(s.goal) ? s.goal : null;
  // the card belongs to the goal it opened for: a cleared or replaced goal's pill starts closed
  const [openFor, setOpenFor] = useState<number | null>(null);
  return (
    <>
      {goal && (
        <div className="composer-pills">
          <GoalPill
            threadId={threadId}
            goal={goal}
            clock={s.goalClock}
            open={openFor === goal.createdAt}
            onOpenChange={(open) => setOpenFor(open ? goal.createdAt : null)}
          />
        </div>
      )}
      {showInbox && (
        <Suspense fallback={null}>
          <PrInboxOwner threadId={threadId} />
        </Suspense>
      )}
    </>
  );
}
