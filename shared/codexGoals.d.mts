import type { ChatGoal } from './model/store';

/** One app-server request a goal action sends. */
export interface GoalRequest {
  method: 'thread/goal/set' | 'thread/goal/clear' | 'turn/interrupt';
  params: Record<string, unknown>;
}

export function goalPausePlan(threadId: string, goal: ChatGoal | null | undefined, activeTurnId: string | null | undefined): GoalRequest[];
export function canResumeGoal(goal: ChatGoal | null | undefined): boolean;
export function goalResumePlan(threadId: string, goal: ChatGoal | null | undefined): GoalRequest[];
export function goalEditPlan(threadId: string, goal: ChatGoal | null | undefined, objective: string): GoalRequest[];
export function goalBudgetPlan(threadId: string, goal: ChatGoal | null | undefined, tokenBudget: number | null): GoalRequest[];
export function goalClearPlan(threadId: string, goal: ChatGoal | null | undefined): GoalRequest[];
export function goalErrorWords(message: string): string;
export function unsupportedGoalWords(label: string, action: string): string;
