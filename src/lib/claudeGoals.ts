// Claude Code goals as the goal bar and the transcript show them. The parser, the reducer and the
// pause, resume and clear plans live in shared/claudeGoals.mjs, since main runs them
// (electron/harness/claude/adapter.cjs); this file re-exports them and keeps the wording.
import type { ChatGoal } from '../../shared/model/store';
import { pluralize } from './format';

export * from '../../shared/claudeGoals.mjs';

/** Status shown in the goal bar: a goal stopped at the round limit is paused like any other. */
export function claudeGoalStatusText(goal: ChatGoal): string {
  if (goal.status === 'budgetLimited' || goal.status === 'paused') return 'Paused';
  if (goal.status === 'stopped') return 'Stopped';
  if (goal.status === 'complete') return 'Complete';
  return 'Active';
}

const rounds = (n: number) => pluralize(n, 'round');
/** The goal bar's detail: who is holding a paused goal, or how many rounds have run. */
export function claudeGoalDetail(goal: ChatGoal): string {
  const c = goal.claude ?? { iterations: 0, lastReason: null, limit: null };
  if (goal.status === 'paused') return 'Goal paused (kept by MoPilot) · Round count restarts when resumed';
  if (goal.status === 'budgetLimited') return `Reached the limit (${rounds(c.limit ?? c.iterations)}). Goal paused · Limit set by MoPilot`;
  return c.limit != null && goal.status === 'active' ? `${c.iterations} / ${rounds(c.limit)}` : rounds(c.iterations);
}

/** The goal pill's progress while a Claude goal runs: the turns (goal checks) it has taken. */
export function claudeGoalTurns(goal: ChatGoal): string {
  const n = goal.claude?.iterations ?? 0;
  return pluralize(n, 'turn');
}
