// The goal bar's detail line when a goal stopped at its budget, per harness.

import type { ChatGoal } from '../../shared/model/store';

type GoalDetailFormatters = {
  codex: (goal: ChatGoal) => string | null;
  claude: (goal: ChatGoal) => string | null;
};

/** Explain a stopping limit without exposing routine budget or round accounting. */
export function goalBarDetail(goal: ChatGoal, formatters: GoalDetailFormatters): string | null {
  if (goal.status !== 'budgetLimited') return null;
  return goal.claude ? formatters.claude(goal) : formatters.codex(goal);
}
