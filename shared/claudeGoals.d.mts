import type { ChatGoal } from './model/store';

/** What a Claude message says about the chat's goal. */
export type ClaudeGoalEvent =
  | { kind: 'set'; condition: string }
  | { kind: 'check'; condition: string; reason: string }
  | { kind: 'active'; condition: string }
  | { kind: 'cleared' }
  | { kind: 'none' };

/** The goal_status record Claude Code writes to the session transcript when a check runs. */
export interface ClaudeGoalStatus {
  met: boolean;
  condition?: string;
  reason?: string;
}

/** A step Sage takes for a goal button: stop the running loop, or send a /goal command to the CLI. */
export type ClaudeGoalAction = { kind: 'interrupt' } | { kind: 'send'; text: string };

export const CLAUDE_GOAL_ROUND_LIMIT: number;
export const CLAUDE_GOAL_EXTRA_ROUNDS: number;
export function claudeGoalRoundLimit(metered: boolean): number | null;
export function claudeLocalOutput(m: unknown): string | null;
export function parseClaudeGoalMessage(m: unknown): ClaudeGoalEvent | null;
export function reduceClaudeGoal(
  goal: ChatGoal | null | undefined,
  e: ClaudeGoalEvent,
  ctx: { chatId: string; limit: number | null; now: number },
): ChatGoal | null | undefined;
export function claudeGoalAfterTurn(goal: ChatGoal | null | undefined, status: ClaudeGoalStatus | null, now: number): ChatGoal | undefined;
export function lastGoalStatus(jsonl: string): ClaudeGoalStatus | null;
export function claudeGoalOverLimit(goal: ChatGoal | null | undefined): boolean;
export function claudeGoalPausePlan(goal: ChatGoal | null | undefined, running: boolean): ClaudeGoalAction[];
export function canResumeClaudeGoal(goal: ChatGoal | null | undefined): boolean;
export function canExtendClaudeGoal(goal: ChatGoal | null | undefined): boolean;
export function claudeGoalExtended(goal: ChatGoal, now: number): ChatGoal;
export function claudeGoalResumePlan(goal: ChatGoal | null | undefined, afterCrash?: boolean): ClaudeGoalAction[];
export function claudeGoalClearPlan(goal: ChatGoal | null | undefined, running: boolean): ClaudeGoalAction[];
export function claudeGoalNote(e: ClaudeGoalEvent, raw?: string | null): string;

/** The decoded goal attachment, or null for other records. */
export function goalStatusAttachment(record: Record<string, unknown>): Record<string, unknown> | null;
