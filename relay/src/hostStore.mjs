// Postgres access for Hosts on the relay (#2709): the credential an app issued for one Host (only its SHA-256 is kept), the
// account and app device it belongs to, and the pair (app host lane ↔ Host) it may carry frames on. Removing the pair removes
// the credential (ON DELETE CASCADE), so every path that forgets pairs (revoke, purge) forgets Hosts too.

/** @typedef {import('./store.mjs').Db} Db */
/** @typedef {{ hostId: string, userId: string, ownerDeviceId: string, pairId: string, secretHash: Buffer, lastSeenAt: number | null }} HostRow */

const ms = (/** @type {number} */ n) => new Date(n);

const hostRow = (/** @type {any} */ r) => ({
  hostId: r.host_id,
  userId: r.user_id,
  ownerDeviceId: r.owner_device_id,
  pairId: r.pair_id,
  secretHash: Buffer.from(r.secret_hash),
  lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).getTime() : null,
});

export class HostStore {
  /** @param {Db} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Adds a Host's credential and its joined pair, in one statement, unless the account already has `cap` Hosts or the id or pair is taken.
   * @param {{ hostId: string, pairId: string, userId: string, laneId: string, ownerDeviceId: string, secretHash: Buffer, now: number, cap: number }} h
   * @returns {Promise<'ok' | 'host_exists' | 'host_limit'>}
   */
  async register({ hostId, pairId, userId, laneId, ownerDeviceId, secretHash, now, cap }) {
    const { rows } = await this.db.query(
      `WITH n AS (SELECT count(*) AS c FROM relay_hosts WHERE user_id = $3::text),
       p AS (
         INSERT INTO relay_pairs (pair_id, user_id, mac_device_id, phone_device_id, join_deadline, created_at, joined_at)
         SELECT $2::text, $3::text, $4::text, $1::text, $6::timestamptz, $6::timestamptz, $6::timestamptz
         WHERE (SELECT c FROM n) < $7::int AND NOT EXISTS (SELECT 1 FROM relay_hosts WHERE host_id = $1::text)
         ON CONFLICT (pair_id) DO NOTHING
         RETURNING pair_id
       )
       INSERT INTO relay_hosts (host_id, user_id, owner_device_id, pair_id, secret_hash, created_at)
       SELECT $1::text, $3::text, $5::text, pair_id, $8::bytea, $6::timestamptz FROM p
       RETURNING host_id`,
      [hostId, pairId, userId, laneId, ownerDeviceId, ms(now), cap, secretHash],
    );
    if (rows.length) return 'ok';
    const { rows: count } = await this.db.query('SELECT count(*) AS c FROM relay_hosts WHERE user_id = $1', [userId]);
    return Number(count[0].c) >= cap ? 'host_limit' : 'host_exists';
  }

  /** @returns {Promise<HostRow | null>} */
  async get(/** @type {string} */ hostId) {
    const { rows } = await this.db.query('SELECT * FROM relay_hosts WHERE host_id = $1', [hostId]);
    return rows[0] ? hostRow(rows[0]) : null;
  }

  /** The Hosts an app device issued, oldest first. @returns {Promise<HostRow[]>} */
  async ofOwner(/** @type {string} */ userId, /** @type {string} */ ownerDeviceId) {
    const { rows } = await this.db.query('SELECT * FROM relay_hosts WHERE user_id = $1 AND owner_device_id = $2 ORDER BY created_at', [
      userId,
      ownerDeviceId,
    ]);
    return rows.map(hostRow);
  }

  /** Removes one Host of the account (its pair, and with it the credential). @returns {Promise<{ hostId: string, pairId: string, laneId: string } | null>} null when there was none; `laneId` is the issuing app's lane */
  async revoke(/** @type {{ hostId: string, userId: string }} */ { hostId, userId }) {
    const { rows } = await this.db.query(
      `DELETE FROM relay_pairs WHERE pair_id = (SELECT pair_id FROM relay_hosts WHERE host_id = $1 AND user_id = $2) RETURNING pair_id, mac_device_id`,
      [hostId, userId],
    );
    return rows.length ? { hostId, pairId: rows[0].pair_id, laneId: rows[0].mac_device_id } : null;
  }

  /** Removes every Host an app device issued (the device was revoked). @returns {Promise<{ hostId: string, pairId: string }[]>} */
  async revokeOwner(/** @type {{ userId: string, ownerDeviceId: string }} */ { userId, ownerDeviceId }) {
    const { rows } = await this.db.query(
      `DELETE FROM relay_pairs WHERE pair_id IN (SELECT pair_id FROM relay_hosts WHERE user_id = $1 AND owner_device_id = $2)
       RETURNING pair_id, phone_device_id`,
      [userId, ownerDeviceId],
    );
    return rows.map((r) => ({ hostId: r.phone_device_id, pairId: r.pair_id }));
  }

  /** Notes that the Host connected. */
  async touch(/** @type {string} */ hostId, /** @type {number} */ now) {
    await this.db.query('UPDATE relay_hosts SET last_seen_at = $2 WHERE host_id = $1', [hostId, ms(now)]);
  }
}
