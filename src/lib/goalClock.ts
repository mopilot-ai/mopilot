// The window's elapsed-time estimate for an active goal between harness reports.
import type { ChatGoal } from '../../shared/model/store';

export type GoalClock = {
  threadId: string;
  createdAt: number;
  startedAt: number;
  reported: number;
  ms: number;
  at: number;
};

export const goalElapsedMs = (clock: GoalClock, now: number) => clock.ms + Math.max(0, now - clock.at);

/** Reconcile one chat's clock when the window accepts a goal snapshot, even with no mounted goal pill. */
export function updateGoalClock(clock: GoalClock | undefined, goal: ChatGoal | null): GoalClock | undefined {
  if (goal?.status !== 'active' || goal.claude) return undefined;
  const { threadId, createdAt } = goal;
  const reported = goal.timeUsedSeconds || 0;
  if (!clock || clock.threadId !== threadId || clock.createdAt !== createdAt) {
    const at = Date.now();
    return { threadId, createdAt, startedAt: at, reported, ms: reported * 1000, at };
  }
  if (clock.reported === reported) return clock;

  const at = Date.now();
  const current = goalElapsedMs(clock, at);
  // A delayed report must not rewind the clock. Forward corrections keep its subsecond phase.
  return { ...clock, reported, ms: Math.max(reported * 1000 + (current % 1000), current), at };
}
