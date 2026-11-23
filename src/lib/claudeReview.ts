// Code review asks: what a Claude Code chat is sent for each review target, and the arguments of a harness's own /review.
import { claudeReviewPrompt as sharedPrompt } from '../../shared/reviewAsk.mjs';
import type { ReviewAsk } from '../../shared/model/window';
export type { ReviewAsk } from '../../shared/model/window';

/** What a Claude Code chat is asked to review: its own /code-review for the working tree, plain words for the rest. */
export const claudeReviewPrompt: (target: ReviewAsk | null | undefined) => string = sharedPrompt;

/** The message that asks an existing Claude Code chat for a review: typed /review <args> is the CLI's own /code-review with them. */
export function claudeReviewMessage(target: ReviewAsk | null | undefined): string {
  return target?.type === 'custom' && target.instructions ? `/code-review ${target.instructions}` : claudeReviewPrompt(target);
}

/** The arguments of a harness's own /review: none for the working tree, the instructions, or the plain-words ask. */
export function reviewArgs(target: ReviewAsk | null | undefined): string {
  if (!target || target.type === 'uncommittedChanges') return '';
  return target.type === 'custom' ? (target.instructions ?? '') : claudeReviewPrompt(target);
}
