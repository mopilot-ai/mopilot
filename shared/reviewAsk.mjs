// What a chat is asked when it reviews code, worded once: the review menus send it (src/lib/claudeReview.ts), and main
// tells a review turn from its prompt by the same words (electron/session/reviewAutoFix.cjs).

/** The ask a plain-words review ends with. */
const ASK = 'Find bugs, regressions and risky changes; list findings by severity with file and line references.';
/** The start of a plain-words review of the current changes (a custom target's instructions follow it). */
const CURRENT = 'Review the current changes.';

/**
 * What a Claude Code chat is asked to review: its own /code-review for the working tree, plain words for the rest.
 * @param {{ type: string, branch?: string, sha?: string, title?: string | null, instructions?: string } | null | undefined} target
 */
export function claudeReviewPrompt(target) {
  switch (target?.type) {
    case 'baseBranch':
      return `Review the changes on this branch against ${target.branch}: read them with the diff of ${target.branch}...HEAD. ${ASK}`;
    case 'commit':
      return `Review the changes in commit ${target.sha}${target.title ? ` (${target.title})` : ''}. ${ASK}`;
    case 'custom':
      return `${CURRENT} ${target.instructions ?? ''}`.trim();
    default:
      return '/code-review';
  }
}

/** A review command a harness runs in the chat itself. */
const COMMAND = /^\s*\/(?:code-review|review|security-review)(?:\s|$)/;
/** A review that only starts in the cloud, whose findings come later and elsewhere (/ultrareview, /code-review ultra). */
const CLOUD = /^\s*\/(?:ultrareview(?:\s|$)|code-review(?:\s+\S+)*?\s+ultra(?:\s|$))/;

/**
 * Whether a turn's prompt asks for a code review whose findings its reply holds: a review command, or a review menu's
 * plain words. A cloud review, which only starts here, is not one.
 * @param {unknown} text
 */
export function isReviewAsk(text) {
  const t = typeof text === 'string' ? text : '';
  if (CLOUD.test(t)) return false;
  return COMMAND.test(t) || t.includes(ASK) || t.trimStart().startsWith(CURRENT);
}
