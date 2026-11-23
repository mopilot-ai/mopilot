// Postgres access for the relay: pairs, the per-pair mailbox of sealed frames, drop notices, push tokens, revoked
// devices and the accounts whose relay access is switched off. Frame bodies are opaque bytes here; nothing in this file looks inside a `box`.

/** @typedef {{ query(text: string, params?: unknown[]): Promise<{ rows: any[], rowCount?: number | null }> }} Db */

const ms = (/** @type {number} */ n) => new Date(n);

/** Unjoined pairs one Mac may hold open at once: each is a QR code on screen, so a person never needs more than a few. */
export const MAX_PENDING_PAIRS = 25;
/** How long a revoked device stays on the relay's list. */
export const REVOKED_KEEP_MS = 7 * 24 * 3600_000;
/** How long an unjoined pair outlives its join window before the sweep forgets it (a late join is then still told it expired). */
export const PENDING_PAIR_KEEP_MS = 24 * 3600_000;

/** A cap that refuses nothing, for a caller that names none. */
const NO_CAP = Object.freeze({ frames: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER });
const MAX_SAFE_PAIRS = 2 ** 31 - 1;

export class Store {
  /** @param {Db} db */
  constructor(db) {
    this.db = db;
  }

  /** Registers a pending pair for a Mac, unless it already holds MAX_PENDING_PAIRS open ones. A pending pair can be re-registered by the same Mac; a joined one cannot. */
  async registerPair({ pairId, userId, macDeviceId, now, joinMs }) {
    const { rows } = await this.db.query(
      `INSERT INTO relay_pairs (pair_id, user_id, mac_device_id, join_deadline, created_at)
       SELECT $1::text, $2::text, $3::text, $4::timestamptz, $5::timestamptz
       WHERE (SELECT count(*) FROM relay_pairs
              WHERE mac_device_id = $3::text AND phone_device_id IS NULL AND join_deadline > $5::timestamptz AND pair_id <> $1::text) < $6::int
       ON CONFLICT (pair_id) DO UPDATE SET join_deadline = $4
         WHERE relay_pairs.phone_device_id IS NULL AND relay_pairs.user_id = $2 AND relay_pairs.mac_device_id = $3
       RETURNING pair_id`,
      [pairId, userId, macDeviceId, ms(now + joinMs), ms(now), MAX_PENDING_PAIRS],
    );
    return rows.length > 0;
  }

  /** Forgets pairs nobody joined, once their window closed more than PENDING_PAIR_KEEP_MS ago. */
  async sweepPendingPairs(/** @type {number} */ now) {
    await this.db.query('DELETE FROM relay_pairs WHERE phone_device_id IS NULL AND join_deadline < $1', [ms(now - PENDING_PAIR_KEEP_MS)]);
  }

  /**
   * The phone joins a pending pair of its own account. Joining again as the same phone is fine (a reconnect).
   * An account that already has `maxPairs` joined is refused `pair_limit`: every joined pair is a mailbox the relay keeps.
   * @returns {Promise<{ ok: true, macDeviceId: string } | { ok: false, code: 'unknown_pair' | 'forbidden' | 'expired' | 'taken' | 'pair_limit' }>}
   */
  async joinPair({ pairId, userId, phoneDeviceId, now, maxPairs = MAX_SAFE_PAIRS }) {
    const { rows } = await this.db.query(
      `UPDATE relay_pairs SET phone_device_id = $3, joined_at = $4
       WHERE pair_id = $1 AND user_id = $2 AND phone_device_id IS NULL AND join_deadline > $4
         AND (SELECT count(*) FROM relay_pairs WHERE user_id = $2 AND phone_device_id IS NOT NULL) < $5::int
       RETURNING mac_device_id`,
      [pairId, userId, phoneDeviceId, ms(now), maxPairs],
    );
    if (rows.length) return { ok: true, macDeviceId: rows[0].mac_device_id };
    const pair = await this.getPair(pairId);
    if (!pair) return { ok: false, code: 'unknown_pair' };
    if (pair.userId !== userId) return { ok: false, code: 'forbidden' };
    if (pair.phoneDeviceId === phoneDeviceId) return { ok: true, macDeviceId: pair.macDeviceId };
    if (pair.phoneDeviceId) return { ok: false, code: 'taken' };
    // nobody joined it: its window has closed, or it is still open and it was the account's pair cap that refused the join
    const open = await this.db.query('SELECT 1 FROM relay_pairs WHERE pair_id = $1 AND phone_device_id IS NULL AND join_deadline > $2', [
      pairId,
      ms(now),
    ]);
    return { ok: false, code: open.rows.length ? 'pair_limit' : 'expired' };
  }

  async getPair(/** @type {string} */ pairId) {
    const { rows } = await this.db.query('SELECT * FROM relay_pairs WHERE pair_id = $1', [pairId]);
    return rows[0] ? pairRow(rows[0]) : null;
  }

  /** Joined pairs a device is on, either side. */
  async pairsForDevice(/** @type {string} */ deviceId) {
    const { rows } = await this.db.query(
      'SELECT * FROM relay_pairs WHERE (mac_device_id = $1 OR phone_device_id = $1) ORDER BY created_at',
      [deviceId],
    );
    return rows.map(pairRow);
  }

  /** Joined pairs of a Mac, to tell their phones about its presence. */
  async phonesOfMac(/** @type {string} */ macDeviceId) {
    const { rows } = await this.db.query('SELECT * FROM relay_pairs WHERE mac_device_id = $1 AND phone_device_id IS NOT NULL', [
      macDeviceId,
    ]);
    return rows.map(pairRow);
  }

  /** Removes a pair with its mailbox and notices. */
  /** Whether the phone still has a pair (a Mac's, or a Host's on its host lane `<device>~h`), so its push token is worth keeping. */
  async phoneHasPair(/** @type {string} */ deviceId) {
    const { rows } = await this.db.query('SELECT 1 FROM relay_pairs WHERE phone_device_id = $1 OR mac_device_id = $2 LIMIT 1', [
      deviceId,
      `${deviceId}~h`,
    ]);
    return rows.length > 0;
  }

  async removePair(/** @type {string} */ pairId) {
    const { rows } = await this.db.query('DELETE FROM relay_pairs WHERE pair_id = $1 RETURNING pair_id', [pairId]);
    return rows.length > 0;
  }

  /**
   * Stores one sealed frame unless the pair's mailbox is full (frame count or bytes), or the pairs of its account together hold the
   * account's quota (`account`), or the plain mailbox as a whole holds the relay's (`relay`), in one statement: two senders on one pair
   * cannot both squeeze past its cap, and senders on different pairs can pass the account's or the relay's by a frame each. The relay-wide
   * count reads the whole table, which holds only pairing frames while the durable mailbox is on.
   * @returns {Promise<boolean>} false when full
   */
  async enqueue({ pairId, dir, ctr, nonce, box, now, ttlMs, maxFrames, maxBytes, account = NO_CAP, relay = NO_CAP }) {
    const { rows } = await this.db.query(
      `INSERT INTO relay_mailbox (pair_id, dir, ctr, nonce, box, size, created_at, expires_at)
       SELECT $1::text, $2::text, $3::bigint, $4::bytea, $5::bytea, $6::int, $7::timestamptz, $8::timestamptz
       WHERE (SELECT count(*) FROM relay_mailbox WHERE pair_id = $1::text) < $9::int
         AND (SELECT coalesce(sum(size), 0) FROM relay_mailbox WHERE pair_id = $1::text) + $6::int <= $10::bigint
         AND (SELECT count(*) FROM relay_mailbox WHERE pair_id IN
               (SELECT pair_id FROM relay_pairs WHERE user_id = (SELECT user_id FROM relay_pairs WHERE pair_id = $1::text))) < $11::bigint
         AND (SELECT coalesce(sum(size), 0) FROM relay_mailbox WHERE pair_id IN
               (SELECT pair_id FROM relay_pairs WHERE user_id = (SELECT user_id FROM relay_pairs WHERE pair_id = $1::text))) + $6::int <= $12::bigint
         AND (SELECT count(*) FROM relay_mailbox) < $13::bigint
         AND (SELECT coalesce(sum(size), 0) FROM relay_mailbox) + $6::int <= $14::bigint
       RETURNING id`,
      [
        pairId,
        dir,
        ctr,
        nonce,
        box,
        box.length,
        ms(now),
        ms(now + ttlMs),
        maxFrames,
        maxBytes,
        account.frames,
        account.bytes,
        relay.frames,
        relay.bytes,
      ],
    );
    return rows.length > 0;
  }

  /** Deletes the plain mailbox of every pair of one account (its relay access was switched off); resolves how many frames. */
  async clearMailboxes(/** @type {string} */ userId) {
    const { rows } = await this.db.query(
      'DELETE FROM relay_mailbox WHERE pair_id IN (SELECT pair_id FROM relay_pairs WHERE user_id = $1) RETURNING 1',
      [userId],
    );
    return rows.length;
  }

  /** The oldest waiting frames of one direction, in arrival order. */
  async waiting(/** @type {string} */ pairId, /** @type {string} */ dir, /** @type {number} */ limit) {
    const { rows } = await this.db.query(
      'SELECT id, ctr, nonce, box FROM relay_mailbox WHERE pair_id = $1 AND dir = $2 ORDER BY id LIMIT $3',
      [pairId, dir, limit],
    );
    return rows.map((r) => ({ id: String(r.id), ctr: Number(r.ctr), nonce: Buffer.from(r.nonce), box: Buffer.from(r.box) }));
  }

  async deleteFrames(/** @type {string[]} */ ids) {
    if (ids.length) await this.db.query('DELETE FROM relay_mailbox WHERE id = ANY($1::bigint[])', [ids]);
  }

  /**
   * Drops frames past their TTL and records one notice per pair and direction for the sender.
   * @returns {Promise<{ pairId: string, dir: string, dropped: number, firstCtr: number, lastCtr: number }[]>}
   */
  async sweepExpired(/** @type {number} */ now) {
    const { rows } = await this.db.query(
      `WITH gone AS (DELETE FROM relay_mailbox WHERE expires_at <= $1 RETURNING pair_id, dir, ctr)
       INSERT INTO relay_drops (pair_id, dir, dropped, first_ctr, last_ctr, at)
       SELECT pair_id, dir, count(*), min(ctr), max(ctr), $1::timestamptz FROM gone GROUP BY pair_id, dir
       RETURNING pair_id, dir, dropped, first_ctr, last_ctr`,
      [ms(now)],
    );
    return rows.map(dropRow);
  }

  /** Notices the sender has not heard yet (it was offline at sweep time); reading them removes them. */
  async takeDrops(/** @type {string} */ pairId, /** @type {string} */ dir) {
    const { rows } = await this.db.query(
      'DELETE FROM relay_drops WHERE pair_id = $1 AND dir = $2 RETURNING pair_id, dir, dropped, first_ctr, last_ctr',
      [pairId, dir],
    );
    return rows.map(dropRow);
  }

  async setPushToken({ deviceId, userId, platform, token, now }) {
    await this.db.query('DELETE FROM relay_push_tokens WHERE token = $1 AND device_id <> $2', [token, deviceId]);
    await this.db.query(
      `INSERT INTO relay_push_tokens (device_id, user_id, platform, token, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (device_id) DO UPDATE SET user_id = $2, platform = $3, updated_at = $5,
         topic = CASE WHEN relay_push_tokens.token = $4 THEN relay_push_tokens.topic END, token = $4`,
      [deviceId, userId, platform, token, ms(now)],
    );
  }

  /** Remembers which APNs topic (credential set) sent to the token; only that token, so a late answer about a replaced token cannot mark the new one. */
  async setPushTopic(/** @type {string} */ deviceId, /** @type {string} */ token, /** @type {string} */ topic) {
    await this.db.query('UPDATE relay_push_tokens SET topic = $3 WHERE device_id = $1 AND token = $2', [deviceId, token, topic]);
  }

  /** The same memory for a Live Activity token. */
  async setActivityTopic(/** @type {string} */ deviceId, /** @type {string} */ token, /** @type {string} */ topic) {
    await this.db.query('UPDATE relay_activity_tokens SET topic = $3 WHERE device_id = $1 AND token = $2', [deviceId, token, topic]);
  }

  /** The topic that last sent to this activity token, or null. */
  async activityTopicOf(/** @type {string} */ deviceId, /** @type {string} */ token) {
    const { rows } = await this.db.query('SELECT topic FROM relay_activity_tokens WHERE device_id = $1 AND token = $2', [deviceId, token]);
    return rows[0]?.topic ?? null;
  }

  /** Removes the device's push token; with `token`, only that one, so a provider's late "dead" about a replaced token cannot remove the new one. */
  async deletePushToken(/** @type {string} */ deviceId, /** @type {string | undefined} */ token = undefined) {
    if (token === undefined) await this.db.query('DELETE FROM relay_push_tokens WHERE device_id = $1', [deviceId]);
    else await this.db.query('DELETE FROM relay_push_tokens WHERE device_id = $1 AND token = $2', [deviceId, token]);
  }

  async setActivityToken({ deviceId, userId, token, now }) {
    await this.db.query(
      `INSERT INTO relay_activity_tokens (device_id, user_id, token, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (device_id) DO UPDATE SET user_id = $2, updated_at = $4,
         topic = CASE WHEN relay_activity_tokens.token = $3 THEN relay_activity_tokens.topic END, token = $3`,
      [deviceId, userId, token, ms(now)],
    );
  }

  /** Removes the device's activity token; with `token`, only that one, so a late answer about an ended activity cannot remove the token of the next. */
  async deleteActivityToken(/** @type {string} */ deviceId, /** @type {string | undefined} */ token = undefined) {
    if (token === undefined) await this.db.query('DELETE FROM relay_activity_tokens WHERE device_id = $1', [deviceId]);
    else await this.db.query('DELETE FROM relay_activity_tokens WHERE device_id = $1 AND token = $2', [deviceId, token]);
  }

  async activityTokenOf(/** @type {string} */ deviceId) {
    const { rows } = await this.db.query('SELECT token FROM relay_activity_tokens WHERE device_id = $1', [deviceId]);
    return rows[0] ? /** @type {string} */ (rows[0].token) : null;
  }

  async pushTokenOf(/** @type {string} */ deviceId) {
    const { rows } = await this.db.query('SELECT platform, token, topic FROM relay_push_tokens WHERE device_id = $1', [deviceId]);
    // `topic` (the APNs credential set that last sent to it) only once one is remembered
    return rows[0]
      ? { platform: rows[0].platform, token: rows[0].token, ...(rows[0].topic && { topic: /** @type {string} */ (rows[0].topic) }) }
      : null;
  }

  /**
   * Records a revoked device and removes everything it held: its push token and its pairs (with their mailboxes).
   * @returns {Promise<{ pairId: string, peerDeviceId: string | null }[] | null>} the pairs it was on, so the peers can be told; null for a device that belongs to another account
   */
  async revokeDevice({ deviceId, userId, now }) {
    // a device that has pairs under another account is not this account's to revoke (a signed request names its own user, never another's device)
    const foreign = await this.db.query(
      'SELECT 1 FROM relay_pairs WHERE (mac_device_id = $1 OR phone_device_id = $1) AND user_id <> $2 LIMIT 1',
      [deviceId, userId],
    );
    if (foreign.rows.length) return null;
    await this.db.query(
      'INSERT INTO relay_revoked_devices (device_id, user_id, revoked_at) VALUES ($1, $2, $3) ON CONFLICT (device_id) DO NOTHING',
      [deviceId, userId, ms(now)],
    );
    await this.deletePushToken(deviceId);
    await this.deleteActivityToken(deviceId);
    const { rows } = await this.db.query(
      `DELETE FROM relay_pairs WHERE mac_device_id = $1 OR phone_device_id = $1
       RETURNING pair_id, mac_device_id, phone_device_id`,
      [deviceId],
    );
    return rows.map((r) => ({
      pairId: r.pair_id,
      peerDeviceId: (r.mac_device_id === deviceId ? r.phone_device_id : r.mac_device_id) ?? null,
    }));
  }

  /**
   * Forgets what the relay holds for a user whose account was deleted: their pairs (with mailboxes, drops and epochs, by cascade)
   * and push tokens; revoked-device rows keep only the device id.
   * @returns {Promise<{ pairId: string, macDeviceId: string, phoneDeviceId: string | null }[]>} the pairs removed
   */
  async purgeUser(/** @type {string} */ userId) {
    // the statements that can be repeated first and the one whose rows are the result last: a failure part way leaves a retry something to return
    await this.db.query('DELETE FROM relay_push_tokens WHERE user_id = $1', [userId]);
    await this.db.query('DELETE FROM relay_activity_tokens WHERE user_id = $1', [userId]);
    await this.db.query("UPDATE relay_revoked_devices SET user_id = 'deleted' WHERE user_id = $1", [userId]);
    await this.db.query('DELETE FROM relay_disabled_accounts WHERE user_id = $1', [userId]);
    const { rows } = await this.db.query('DELETE FROM relay_pairs WHERE user_id = $1 RETURNING pair_id, mac_device_id, phone_device_id', [
      userId,
    ]);
    return rows.map((r) => ({ pairId: r.pair_id, macDeviceId: r.mac_device_id, phoneDeviceId: r.phone_device_id ?? null }));
  }

  /** Forgets revoked-device rows older than REVOKED_KEEP_MS: a relay token lives 15 minutes and the account service refuses the device's refresh token for good, so the row has done its work. */
  async sweepRevoked(/** @type {number} */ now) {
    await this.db.query('DELETE FROM relay_revoked_devices WHERE revoked_at < $1', [ms(now - REVOKED_KEEP_MS)]);
  }

  async isRevoked(/** @type {string} */ deviceId) {
    const { rows } = await this.db.query('SELECT 1 FROM relay_revoked_devices WHERE device_id = $1', [deviceId]);
    return rows.length > 0;
  }

  /** Records that an account's relay access was switched off at `at` (the account service's clock); a repeat keeps the later time. */
  async disableAccount(/** @type {string} */ userId, /** @type {number} */ at) {
    await this.db.query(
      `INSERT INTO relay_disabled_accounts (user_id, disabled_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET disabled_at = GREATEST(relay_disabled_accounts.disabled_at, EXCLUDED.disabled_at)`,
      [userId, ms(at)],
    );
  }

  /** Forgets a switch-off made at or before `through`; one made later stands. */
  async enableAccount(/** @type {string} */ userId, /** @type {number} */ through) {
    await this.db.query('DELETE FROM relay_disabled_accounts WHERE user_id = $1 AND disabled_at <= $2', [userId, ms(through)]);
  }

  /** When an account's relay access was switched off (epoch ms), or null while it is on. */
  async disabledAt(/** @type {string} */ userId) {
    const { rows } = await this.db.query('SELECT disabled_at FROM relay_disabled_accounts WHERE user_id = $1', [userId]);
    return rows.length ? new Date(rows[0].disabled_at).getTime() : null;
  }
}

const pairRow = (/** @type {any} */ r) => ({
  pairId: r.pair_id,
  userId: r.user_id,
  macDeviceId: r.mac_device_id,
  phoneDeviceId: r.phone_device_id ?? null,
});

const dropRow = (/** @type {any} */ r) => ({
  pairId: r.pair_id,
  dir: r.dir,
  dropped: Number(r.dropped),
  firstCtr: Number(r.first_ctr),
  lastCtr: Number(r.last_ctr),
});
