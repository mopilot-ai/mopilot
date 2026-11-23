// What a relay refusal means to the phone runtime: the words and the wait when a socket is closed with one, the refusal in a failed connect, and the reconnector's outcome for it.
import { REFUSAL_TEXT, RelayRefused, refusalWait, type RelayRefusal } from '../../shared/remote/relayRefusal.mjs';
import { isPassingRefusal, isTransient, type ReconnectOutcome } from './reconnect';
import { RemoteCryptoError } from '../../shared/remote/crypto.mjs';
import { PAIR_LOST_LINE } from './pairLost';

export type { RelayRefusal };

/** The relay's refusal in a failed connect, or null for any other failure. */
export const refusalIn = (error: unknown): RelayRefusal | null => (error instanceof RelayRefused ? error.refusal : null);

/**
 * How long the phone waits before it asks again by itself after a refusal that passes (a full relay, the account's device limit). A
 * switched-off account, like no refusal, has no wait of its own: the next try asks the account service, which says whether it still holds.
 */
export const refusedWait = (refusal: RelayRefusal | null, random: () => number = Math.random) =>
  refusal && refusal !== 'disabled' ? refusalWait(0, random()) : undefined;

/**
 * A closed relay socket as the runtime's lost-connection path takes it: what the person reads, the wait, and the refusal. The relay client
 * rejects a refused connect and reports the close in the same turn, so the wait is decided here, before the connect's own failure is handled.
 */
export const closedBy = (refusal?: RelayRefusal | null): [error: string, delayMs: number | undefined, refusal: RelayRefusal | null] => [
  refusal ? REFUSAL_TEXT[refusal] : 'Relay disconnected',
  refusedWait(refusal ?? null),
  refusal ?? null,
];

/** What the reconnector does after a failed attempt: wait the refusal's time, wait the usual time, or stop. */
export const outcomeOf = (error: unknown): ReconnectOutcome =>
  isPassingRefusal(error) ? 'refused' : isTransient(error) ? 'retry' : 'stop';

/** The line an error shows on the home screen: the catch-up failure (a computer too far ahead) says what to do, any other keeps its own words. */
export const errorLine = (error: unknown) =>
  error instanceof RemoteCryptoError && error.code === 'lost'
    ? PAIR_LOST_LINE
    : error instanceof Error
      ? error.message
      : 'Operation failed';
