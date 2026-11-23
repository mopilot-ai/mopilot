// The line a card that a Host closed leaves in the thread ("Allowed on Pocket iPhone", "Not answered", "Cancelled"): the words are shared/host/cardClosed.mjs, read by both clients; what a stream event adds to the card it closes is here.
const { closedLine } = require('../../shared/host/cardClosed.mjs');

/** What a stream event adds to the card it closes: `{ line }` for a `permissionCancelled` that has one, nothing for any other event. @param {any} event @param {Parameters<typeof closedLine>[1]} [o] */
const closedPatch = (event, o) => {
  const line = event.kind === 'permissionCancelled' ? closedLine(event, o) : null;
  return line ? { line } : {};
};

/**
 * The transcript record of a card a Host closed, for the chat's history to show its outcome in its turn whenever the chat is opened (the core replays `card` as a note): none for a close with no line, or no turn to place it in (an older Host).
 * @param {any} event a `permissionCancelled` item @param {string} id the card's id in this app @param {string | undefined} line
 * @param {number} at
 * @returns {{ t: 'card', turnId: string, requestId: string, line: string, reason: string, at: number } | null}
 */
const cardRecord = (event, id, line, at) =>
  line && typeof event.turnId === 'string' && event.turnId
    ? { t: 'card', turnId: event.turnId, requestId: id, line, reason: String(event.reason), at }
    : null;

module.exports = { closedLine, closedPatch, cardRecord };
