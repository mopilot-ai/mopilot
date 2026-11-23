// Native delivery receipts distinguish accepted turns from input retained by main for an explicit retry.
const ACCEPTED = new Set(['started', 'steered', 'queued', 'held', 'discarded', 'dispatched']);
const REFUSED = 'The harness did not accept the message.';

/** One completed adapter attempt; a retained item must never be restored in a second owner. */
export function sendReceipt(result, id, queued, accepted = 'started') {
  if (result?.started) return { action: result.delivery === 'dispatched' ? 'dispatched' : accepted, id };
  if (result?.held) return { action: 'held', id };
  if (result?.discarded) return { action: 'discarded', id };
  return { action: queued ? 'queued' : 'failed', id, error: result?.error || REFUSED };
}

/** Whether main's acknowledgment says the harness took the turn (or main kept it); a refused or malformed one did not. */
export function isAcceptedReceipt(receipt) {
  return !!receipt && typeof receipt.id === 'string' && !!receipt.id && ACCEPTED.has(receipt.action);
}

/** Validates main's acknowledgment; returns a queued failure for display without duplicating its retained input. */
export function acceptSendReceipt(receipt) {
  if (!isAcceptedReceipt(receipt)) throw new Error(typeof receipt?.error === 'string' && receipt.error ? receipt.error : REFUSED);
  return receipt.action === 'queued' && typeof receipt.error === 'string' ? receipt.error : null;
}
