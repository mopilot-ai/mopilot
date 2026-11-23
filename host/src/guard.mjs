// The Host's gate for a chat request that changes something: the epoch is checked first, then the ledger decides whether the request runs, replays or is reported indeterminate.

/**
 * @param {{ epochs: ReturnType<typeof import('./epochs.mjs').createEpochStore>, ledger: ReturnType<typeof import('./ledger.mjs').createLedger> }} o
 */
/** The requests that are safe to run again: a deletion removes what is left, whatever an earlier run did before it stopped. */
const IDEMPOTENT = new Set(['chat.remove']);

export function createGuard({ epochs, ledger }) {
  /**
   * @template T
   * @param {{ chatId: string, epoch: number, key: string, method: string, by?: { fingerprint: string, name: string, kind: string } }} req a parsed request (shared/host/schema.mjs)
   * @param {() => Promise<T> | T} act
   */
  const guard = async (req, act) => {
    epochs.admit(req.chatId, req.epoch);
    return ledger.once({ ...req, idempotent: IDEMPOTENT.has(req.method) }, act);
  };
  // what a deleted chat leaves in the ledger (./ledger.mjs): who sent it requests, and the request log reduced to the deletion's own entry
  return Object.assign(guard, { clients: ledger.clients, retire: ledger.retire });
}
