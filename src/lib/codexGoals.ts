// Codex goals in the renderer: parsing /goal commands and token budgets, and the goal bar's words. The app-server requests each action sends (the plans) are shared/codexGoals.mjs, which a Host runs too.

import { ownTable } from '../../shared/ownTable.mjs';
import { goalErrorWords } from '../../shared/codexGoals.mjs';
import type { ChatGoal as ThreadGoal, ChatGoalStatus } from '../../shared/model/store';
import { compactCount } from './format';
import { errorText } from './ignored';

/** What "/goal …" asks for: show the current goal, clear, pause or resume it, edit its objective, or set a new one. */
export type GoalCommand =
  | { kind: 'show' }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'edit'; objective: string }
  | { kind: 'budget'; tokens: number | null }
  | { kind: 'set'; objective: string };

/**
 * A token budget as typed: "200k", "1.5m", "200000"; "none" or an empty string removes it (null).
 * undefined when it isn't a budget at all.
 */
export function parseTokenBudget(text: string): number | null | undefined {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s*tokens?$/, '');
  if (t === '' || t === 'none' || t === 'off' || t === 'clear') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(t);
  if (!m) return undefined;
  const n = Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
  return n > 0 ? n : undefined;
}

export function parseGoalCommand(args: string): GoalCommand {
  const objective = args.trim();
  if (!objective) return { kind: 'show' };
  const word = objective.toLowerCase();
  if (word === 'clear') return { kind: 'clear' };
  if (word === 'pause') return { kind: 'pause' };
  if (word === 'resume') return { kind: 'resume' };
  // "/goal edit <objective>" rewrites the objective, which may run over several lines; a bare "edit" is still an objective
  const e = /^edit\s+(\S[\s\S]*)$/i.exec(objective);
  if (e) return { kind: 'edit', objective: e[1].trim() };
  // "/goal budget 200k"; anything else starting with the word is an objective
  const b = /^budget\s+(\S[\s\S]*)$/i.exec(objective);
  const tokens = b ? parseTokenBudget(b[1]) : undefined;
  if (tokens !== undefined) return { kind: 'budget', tokens };
  return { kind: 'set', objective };
}

export {
  canResumeGoal,
  goalBudgetPlan,
  goalClearPlan,
  goalEditPlan,
  goalPausePlan,
  goalResumePlan,
  type GoalRequest,
} from '../../shared/codexGoals.mjs';

/** A readable message for a failed goal request. */
export function goalErrorMessage(e: unknown): string {
  return goalErrorWords(errorText(e));
}

const STATUS_LABEL: Record<ChatGoalStatus, string> = ownTable({
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limit reached',
  budgetLimited: 'Budget reached',
  complete: 'Complete',
  stopped: 'Stopped',
});
export function goalStatusLabel(status: ChatGoalStatus): string {
  return STATUS_LABEL[status] ?? status;
}

/** The token budget is a soft target that runs can overshoot, so it is shown as approximate. */
export function goalBudgetLabel(goal: ThreadGoal): string | null {
  if (goal.tokenBudget == null) return null;
  const k = (n: number) => compactCount(n, 0);
  return `${k(goal.tokenBudget)} token budget (soft, checked between turns) · ${k(goal.tokensUsed)} used`;
}
