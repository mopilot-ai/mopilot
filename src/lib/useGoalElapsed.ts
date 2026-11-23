// Refreshes a visible goal's elapsed time from the clock kept with its chat's session state.
import { useEffect, useId, useState } from 'react';
import type { ChatGoal } from '../../shared/model/store';
import { type GoalClock, goalElapsedMs } from './goalClock';
import { visiblePoll } from './visiblePoll';

/** Only time-based active goals subscribe; round-based goals and stopped goals retain their reported progress. */
export function useGoalElapsed(chatId: string, goal: ChatGoal, clock: GoalClock | undefined): number {
  const active = !!clock;
  const clockId = useId();
  const clockKey = JSON.stringify(['goal-time', clockId, chatId, goal.threadId, goal.createdAt, clock?.startedAt]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return visiblePoll(clockKey, 1000, () => setNow(Date.now()));
  }, [active, clockKey]);
  return clock ? Math.floor(goalElapsedMs(clock, now) / 1000) : goal.timeUsedSeconds || 0;
}
