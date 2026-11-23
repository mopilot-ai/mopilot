// Reads, once per connection, whether a computer answers a repeated send id once (its hello says so).
/** Builds the reader the outbox calls before sending: it fills `sendIds` (this connection) and `lastSendIds` (kept while the computer is away). */
export function createSendIdLearner(o: {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  generation(): number;
  sendIds: Map<string, boolean>;
  lastSendIds: Map<string, boolean>;
}) {
  /** Reads what the computer can do for a queued message, once per connection (false when it changed meanwhile); a computer that cannot answer is not assumed old: the error goes to the message. */
  return async function learnSendIds(pairId: string) {
    if (o.sendIds.has(pairId)) return true;
    const owner = o.generation();
    const hello = await o.request('machine.hello', {}).catch((error) => {
      if (owner === o.generation()) throw error;
      return null;
    });
    if (owner !== o.generation()) return false;
    const known = (hello as { capabilities?: { sendId?: unknown } } | null)?.capabilities?.sendId === true;
    o.sendIds.set(pairId, known);
    o.lastSendIds.set(pairId, known);
    return true;
  };
}
