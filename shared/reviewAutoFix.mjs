// Settings → General → Apply code review fixes automatically: read the same way by the Settings row and by main.

/**
 * Whether a review's findings are applied without a click in every chat. Off unless set; a chat whose PR monitor has
 * Auto-fix on applies them either way (electron/app/reviewAutoFix.cjs).
 * @param {{ autoApplyReviewFixes?: unknown } | null | undefined} prefs
 */
export const autoApplyReviewFixes = (prefs) => prefs?.autoApplyReviewFixes === true;
