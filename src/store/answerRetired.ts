// Answers to approval cards on every harness: main takes one only while it still holds the card, and says so.

/** The one line a window shows when main retired the card an answer was for (answered elsewhere, withdrawn, restarted). */
export const ALREADY_ANSWERED = 'Already answered';

/**
 * Reads main's reply to a card's answer: true when it reached the harness. False (main no longer held that card)
 * says the shared line once through `say` (the caller's toast); nothing was sent.
 */
export function answerTaken(taken: unknown, say: (text: string) => void): boolean {
  if (taken === true) return true;
  say(ALREADY_ANSWERED);
  return false;
}
