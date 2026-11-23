// Types for shared/claudeAnswer.mjs: a card's answer as the Claude Agent SDK's.
import type { ApprovalResult, ClaudeAnswer } from './model/native';
import type { ClaudeToolInput } from './model/requests';

export function claudeAnswer(
  method: string,
  input: ClaudeToolInput | null | undefined,
  result: ApprovalResult | null | undefined,
  suggestions?: unknown[] | null,
): ClaudeAnswer;
