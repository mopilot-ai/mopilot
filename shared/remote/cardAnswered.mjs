// The text a Mac answers with when a card was already answered (on the Mac or another device), and the check a phone shows it by.

/** The refusal's message: a card the Mac no longer holds, or an answer older than the card's version. */
export const CARD_ANSWERED = 'That request was already answered.';

/** Whether an error from `card.answer` means the card was answered elsewhere, as opposed to a refusal the user can act on. */
export const answeredElsewhere = (/** @type {unknown} */ error) => error instanceof Error && error.message === CARD_ANSWERED;
