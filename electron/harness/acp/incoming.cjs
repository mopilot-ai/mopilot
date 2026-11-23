// Connection-scoped deferred ACP replies: typed native IDs, cancellation, and at-most-once local writes.
const DEFERRED_REPLY = Symbol('deferred ACP reply');
const validId = (id) => (typeof id === 'string' && id.length <= 512) || (typeof id === 'number' && Number.isSafeInteger(id));

class IncomingRequests {
  constructor(peer) {
    this.peer = peer;
    this.live = new Map();
  }
  context(id) {
    if (!validId(id)) throw Object.assign(new Error('Invalid request id'), { code: -32600 });
    const owner = this;
    const context = {
      id,
      defer(cancel) {
        if (owner.live.has(id)) throw Object.assign(new Error('Duplicate live request id'), { code: -32600 });
        context.cancel = cancel;
        owner.live.set(id, context);
        return DEFERRED_REPLY;
      },
      respond(result, error) {
        if (owner.live.get(id) !== context) return { status: 'retired' };
        owner.live.delete(id);
        if (owner.peer.closed) return { status: 'failed', error: 'Connection closed. Delivery could not be confirmed.' };
        try {
          owner.peer.send(error ? { id, error } : { id, result });
          return { status: 'written' };
        } catch {
          // A stream may throw after accepting bytes. Never retry a possibly delivered response.
          return { status: 'failed', error: 'Delivery could not be confirmed. Ask for a new question.' };
        }
      },
    };
    return context;
  }
  cancel(id) {
    this.live.get(id)?.cancel();
  }
  close() {
    for (const context of [...this.live.values()]) context.cancel();
  }
}
module.exports = { IncomingRequests, DEFERRED_REPLY, validId };
