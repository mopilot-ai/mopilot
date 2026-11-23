// Says "not confirmed" when a send, stop or answer was in flight as the connection went: the Mac may have taken it, so the phone neither claims success nor "failed". (A queued send says it on the message itself: see isUnconfirmed in outbox.ts.)
export type Unconfirmable = 'send' | 'stop' | 'answer' | 'start';

/** The request left the phone and the answer never came back: the connection closed or the relay stopped waiting. */
const IN_FLIGHT = /^(relay (disconnected|acknowledgement timed out)|Connection closed|Request timed out|Aborted$)/i;

/** Also when a screen's own wording replaced the message and kept the original as its cause (`ownedRequest`). */
export const lostInFlight = (error: unknown, depth = 0): boolean =>
  error instanceof Error &&
  (error.name === 'AbortError' || IN_FLIGHT.test(error.message) || (depth < 4 && lostInFlight(error.cause, depth + 1)));

const NAME: Record<Unconfirmable, string> = { send: 'Send', stop: 'Stop', answer: 'Answer', start: 'Start' };

/** The notice for an action that could not be read back: what is not known, then the one thing to do. */
export const unconfirmedNotice = (action: Unconfirmable) => ({
  lead: `${NAME[action]} not confirmed.`,
  // a chat that may have been started is looked for in the list: there is no chat to check yet
  text: action === 'start' ? 'Check your chats before trying again.' : 'Check the chat before trying again.',
});
