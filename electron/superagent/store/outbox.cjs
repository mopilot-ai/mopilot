// Superagent outbox: queued effects with leases, an allocation-id compare-and-swap and idempotency keys.
// Pattern: karakeep-app/liteque src/queue.ts (lease + allocation id) and earendil-works/absurd sdks/typescript/src/index.ts (heartbeat).

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 5 * 60_000;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now: () => number, newId: () => string }} o injected clock (epoch ms) and id source
 */
function createOutbox(db, { now, newId }) {
  const insert = db.prepare('INSERT OR IGNORE INTO outbox (idempotency_key, kind, payload, run_at) VALUES (?, ?, ?, ?)');
  const byKey = db.prepare('SELECT id FROM outbox WHERE idempotency_key = ?');
  const byId = db.prepare('SELECT * FROM outbox WHERE id = ?');
  const expire = db.prepare(
    "UPDATE outbox SET state = 'dead', error = 'lease expired too many times' WHERE state = 'pending' AND attempts >= ? AND lease_expires_at <= ?",
  );
  const leaseStmt = db.prepare(
    `UPDATE outbox SET lease_owner = ?, lease_expires_at = ?, allocation_id = ?, attempts = attempts + 1
     WHERE id = (SELECT id FROM outbox WHERE state = 'pending' AND run_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                 ORDER BY run_at, id LIMIT 1)
     RETURNING *`,
  );
  const beat = db.prepare("UPDATE outbox SET lease_expires_at = ? WHERE id = ? AND allocation_id = ? AND state = 'pending'");
  const done = db.prepare(
    "UPDATE outbox SET state = 'done', result = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND allocation_id = ? AND state = 'pending'",
  );
  const retry = db.prepare(
    "UPDATE outbox SET state = ?, run_at = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND allocation_id = ? AND state = 'pending'",
  );

  const decode = (row) => (row ? { ...row, payload: JSON.parse(row.payload) } : undefined);

  /** Queues an effect; the same idempotency key keeps its first entry. @returns {{ id: number, created: boolean }} */
  function enqueue({ kind, payload, idempotencyKey, runAt = now() }) {
    const created = insert.run(idempotencyKey, kind, JSON.stringify(payload), runAt).changes === 1;
    return { id: /** @type {any} */ (byKey.get(idempotencyKey)).id, created };
  }

  /** Leases the oldest due entry (new or with an expired lease) under a fresh allocation id, or null. */
  function lease({ owner, ttlMs, maxAttempts = MAX_ATTEMPTS }) {
    // a worker that keeps dying mid-effect never calls fail(): entries it used up are dead, not leased again
    expire.run(maxAttempts, now());
    return decode(leaseStmt.get(owner, now() + ttlMs, newId(), now(), now())) ?? null;
  }

  /** Extends a lease; false once another lease replaced this allocation. */
  const heartbeat = (id, allocationId, ttlMs) => beat.run(now() + ttlMs, id, allocationId).changes === 1;
  /** Completes the entry for the allocation that holds it; a stale holder gets false and changes nothing. */
  const complete = (id, allocationId, result = null) => done.run(JSON.stringify(result), id, allocationId).changes === 1;
  /**
   * Fails an attempt: retried at `retryAt` (default: exponential backoff from one second, capped at five minutes), or
   * dead after `maxAttempts`. Returns false for a stale holder.
   */
  function fail(id, allocationId, { error, retryAt, maxAttempts = MAX_ATTEMPTS }) {
    const row = /** @type {any} */ (byId.get(id));
    const state = row && row.attempts >= maxAttempts ? 'dead' : 'pending';
    const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(row ? row.attempts - 1 : 0, 0), RETRY_CAP_MS);
    return retry.run(state, retryAt ?? now() + backoff, String(error), id, allocationId).changes === 1;
  }
  const get = (id) => decode(byId.get(id));

  return { enqueue, lease, heartbeat, complete, fail, get };
}

module.exports = { createOutbox, MAX_ATTEMPTS };
