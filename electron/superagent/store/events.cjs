// Superagent event log: each event stored once by (source, external_id), with an exactly-once claim that has a TTL.
// Pattern: langchain-ai/open-swe openswe/event_claims.py (claim with TTL; released when the handler fails before its side effect).

class ClaimLostError extends Error {
  constructor() {
    super('The event claim was lost: another owner holds it, so the side effect was not run.');
    this.name = 'ClaimLostError';
  }
}

/** Default heartbeat timer: runs `fn` every `ms` until the returned function is called; never keeps the process alive. */
const everyMs = (fn, ms) => {
  const h = setInterval(fn, ms);
  h.unref?.();
  return () => clearInterval(h);
};

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} o
 * @param {() => number} o.now the injected clock, in epoch milliseconds
 * @param {() => boolean} o.isOpen false once the store is closed: a handler that finishes then leaves its claim to expire
 * @param {(fn: () => void, ms: number) => () => void} [o.every] the heartbeat timer; returns its cancel
 */
function createEventLog(db, { now, isOpen, every = everyMs }) {
  const insert = db.prepare('INSERT OR IGNORE INTO events (source, external_id, payload, received_at) VALUES (?, ?, ?, ?)');
  const byKey = db.prepare('SELECT * FROM events WHERE source = ? AND external_id = ?');
  // a committed event is never claimed again: its side effect may have run, so only a person or S2's reconcile settles it
  const claimStmt = db.prepare(
    `UPDATE events SET claim_owner = ?, claim_expires_at = ?
     WHERE source = ? AND external_id = ? AND done_at IS NULL AND committed_at IS NULL AND (claim_owner IS NULL OR claim_expires_at <= ?)`,
  );
  const extendStmt = db.prepare(
    'UPDATE events SET claim_expires_at = ? WHERE source = ? AND external_id = ? AND claim_owner = ? AND done_at IS NULL',
  );
  const commitStmt = db.prepare(
    'UPDATE events SET committed_at = ? WHERE source = ? AND external_id = ? AND claim_owner = ? AND done_at IS NULL AND committed_at IS NULL',
  );
  const completeStmt = db.prepare(
    'UPDATE events SET done_at = ? WHERE source = ? AND external_id = ? AND claim_owner = ? AND done_at IS NULL',
  );
  const releaseStmt = db.prepare(
    `UPDATE events SET claim_owner = NULL, claim_expires_at = NULL
     WHERE source = ? AND external_id = ? AND claim_owner = ? AND done_at IS NULL AND committed_at IS NULL`,
  );
  const reconcileList = db.prepare(
    'SELECT source, external_id, committed_at FROM events WHERE committed_at IS NOT NULL AND done_at IS NULL AND (claim_expires_at IS NULL OR claim_expires_at <= ?) ORDER BY id',
  );
  const resolveStmt = db.prepare(
    'UPDATE events SET done_at = ? WHERE source = ? AND external_id = ? AND committed_at IS NOT NULL AND done_at IS NULL',
  );

  const get = (source, externalId) => {
    const row = /** @type {any} */ (byKey.get(source, externalId));
    return row ? { ...row, payload: JSON.parse(row.payload) } : undefined;
  };

  /** Stores an event once; a second delivery of the same (source, externalId) changes nothing. @returns {{ id: number, inserted: boolean }} */
  function record(source, externalId, payload) {
    const inserted = insert.run(source, externalId, JSON.stringify(payload), now()).changes === 1;
    return { id: /** @type {any} */ (byKey.get(source, externalId)).id, inserted };
  }

  /** Takes the claim when nobody holds it or its TTL ran out; never once the event is done or committed. */
  const claim = (source, externalId, owner, ttlMs) => claimStmt.run(owner, now() + ttlMs, source, externalId, now()).changes === 1;
  /** Pushes the owner's claim expiry out (a heartbeat); false once another owner took it. */
  const extendClaim = (source, externalId, owner, ttlMs) => extendStmt.run(now() + ttlMs, source, externalId, owner).changes === 1;
  /** Durably records that the side effect is about to run, so a crash can never make it run again. False when the claim was lost. */
  const commit = (source, externalId, owner) => commitStmt.run(now(), source, externalId, owner).changes === 1;
  /** Marks the event done by the claim's owner; false when the claim was lost. */
  const complete = (source, externalId, owner) => completeStmt.run(now(), source, externalId, owner).changes === 1;
  /** Gives the claim up so the next delivery retries; a done or committed event keeps its claim. */
  const release = (source, externalId, owner) => releaseStmt.run(source, externalId, owner).changes === 1;
  /** Events whose side effect may have run but that never finished (the process died): S1 shows them, S2 settles each by its outbox idempotency key. */
  const needsReconcile = () =>
    reconcileList.all(now()).map((r) => ({ source: r.source, externalId: r.external_id, committedAt: r.committed_at }));
  /** Settles a needs-reconcile event once someone confirmed what happened. */
  const resolve = (source, externalId) => resolveStmt.run(now(), source, externalId).changes === 1;

  /**
   * Runs `handler` under the claim, keeping it alive while it runs. The handler calls `commit()` right before its side
   * effect: it is written to the database first (and throws ClaimLostError when the claim is gone). A failure before it
   * releases the claim (the next delivery retries); a failure after it keeps the event done, and a crash after it leaves
   * the event needing reconcile, never run again.
   * `lost` means the claim was taken over while the handler ran; `closed`, that the store closed meanwhile.
   * @returns {Promise<'done' | 'busy' | 'duplicate' | 'reconcile' | 'lost' | 'closed'>}
   */
  async function handle(source, externalId, owner, ttlMs, handler) {
    if (!claim(source, externalId, owner, ttlMs)) {
      const row = get(source, externalId);
      if (row?.done_at) return 'duplicate';
      // committed with no live owner (its process died): settled by a reconcile, never run again
      return row?.committed_at && !(row.claim_expires_at > now()) ? 'reconcile' : 'busy';
    }
    const stop = every(
      () => {
        if (isOpen()) extendClaim(source, externalId, owner, ttlMs);
      },
      Math.max(1, Math.floor(ttlMs / 3)),
    );
    let committed = false;
    try {
      await handler(get(source, externalId), {
        commit: () => {
          if (!commit(source, externalId, owner)) throw new ClaimLostError();
          committed = true;
        },
      });
    } catch (e) {
      // a closed store leaves the claim: it expires, or (committed) waits for reconcile
      if (isOpen()) {
        if (committed) complete(source, externalId, owner);
        else release(source, externalId, owner);
      }
      throw e;
    } finally {
      stop();
    }
    if (!isOpen()) return 'closed';
    return complete(source, externalId, owner) ? 'done' : 'lost';
  }

  return { record, get, claim, extendClaim, commit, complete, release, needsReconcile, resolve, handle };
}

module.exports = { createEventLog, ClaimLostError };
