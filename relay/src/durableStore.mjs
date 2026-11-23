// Isolated v2 relay persistence primitives; no network endpoint or legacy-path behavior enables them.
import { randomUUID } from 'node:crypto';

/** Install the optional durable schema explicitly; the legacy relay does not call this. */
export async function migrateDurable(db) {
  await db.query('CREATE SCHEMA IF NOT EXISTS remote_durable');
  await db.query(`CREATE TABLE IF NOT EXISTS remote_durable.epochs (
    pair_id text PRIMARY KEY REFERENCES public.relay_pairs(pair_id) ON DELETE CASCADE, epoch uuid NOT NULL UNIQUE
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS remote_durable.streams (
    pair_id text NOT NULL REFERENCES public.relay_pairs(pair_id) ON DELETE CASCADE,
    dir text NOT NULL CHECK (dir IN ('m2p','p2m')), highwater bigint NOT NULL,
    PRIMARY KEY (pair_id, dir)
  )`);
  // counters the high-water mark jumped over (a frame stored ahead of a refused or late one): a frame for one is still stored, not
  // answered "consumed"; a gap goes when the receiver acknowledges a later counter, since it can no longer open a frame behind it (#3215)
  await db.query(`CREATE TABLE IF NOT EXISTS remote_durable.gaps (
    pair_id text NOT NULL REFERENCES public.relay_pairs(pair_id) ON DELETE CASCADE,
    dir text NOT NULL CHECK (dir IN ('m2p','p2m')), lo bigint NOT NULL, hi bigint NOT NULL,
    PRIMARY KEY (pair_id, dir, lo)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS remote_durable.drops (
    id uuid PRIMARY KEY, pair_id text NOT NULL REFERENCES public.relay_pairs(pair_id) ON DELETE CASCADE,
    dir text NOT NULL CHECK (dir IN ('m2p','p2m')), first_ctr bigint NOT NULL, last_ctr bigint NOT NULL,
    dropped bigint NOT NULL, at timestamptz NOT NULL, UNIQUE(pair_id, dir)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS remote_durable.frames (
    id uuid PRIMARY KEY, pair_id text NOT NULL REFERENCES public.relay_pairs(pair_id) ON DELETE CASCADE,
    dir text NOT NULL CHECK (dir IN ('m2p','p2m')), ctr bigint NOT NULL,
    nonce bytea NOT NULL, box bytea NOT NULL, expires_at timestamptz NOT NULL,
    UNIQUE(pair_id, dir, ctr)
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS frames_expiry ON remote_durable.frames (expires_at)');
  // frames are inserted and deleted all day: vacuum after 2% dead rows (the default 20% leaves a busy mailbox bloated), and analyze often
  await db.query(
    'ALTER TABLE remote_durable.frames SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.05)',
  );
}

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} DurableTransaction
 * @typedef {<T>(work: (tx: DurableTransaction) => Promise<T>) => Promise<T>} TransactionRunner
 * A runner must use one dedicated database transaction, commit only on success and roll back on error.
 * All limits and timestamps are trusted server policy, not values supplied by an untrusted client.
 */
/** Operations use a dedicated transaction. The pair row lock serializes every v2 mutation for that pair. */
export class DurableStore {
  /** @param {TransactionRunner} transaction */
  constructor(transaction) {
    this.transaction = transaction;
  }

  async openEpoch(a) {
    a = { ...a };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, a, 'mac', { epoch: false });
      if (g.code !== 'ok') return { code: 'forbidden' };
      if (g.epoch) return { code: 'ok', epoch: g.epoch };
      const epoch = randomUUID();
      await tx.query('INSERT INTO remote_durable.epochs (pair_id,epoch) VALUES ($1,$2)', [a.pairId, epoch]);
      return { code: 'ok', epoch };
    });
  }

  /**
   * One statement decides whether the caller may act on the pair (it exists, is joined, belongs to the caller's account, the
   * caller is the right end for `role`, neither device is revoked) and whether the caller's epoch is the pair's current one.
   * `lock` takes the pair's row lock, which serializes every mutation of the pair; reads skip it.
   * @returns {Promise<{ code: 'ok' | 'forbidden' | 'retired', epoch?: string }>}
   */
  async #guard(tx, a, role, { lock = true, epoch = true } = {}) {
    if (typeof a.pairId !== 'string' || typeof a.userId !== 'string') return { code: 'forbidden' };
    const { rows } = await tx.query(
      `SELECT p.user_id, p.mac_device_id, p.phone_device_id, e.epoch,
         EXISTS (SELECT 1 FROM public.relay_revoked_devices r WHERE r.device_id = p.mac_device_id OR r.device_id = p.phone_device_id) AS revoked
       FROM public.relay_pairs p LEFT JOIN remote_durable.epochs e ON e.pair_id = p.pair_id
       WHERE p.pair_id = $1${lock ? ' FOR UPDATE OF p' : ''}`,
      [a.pairId],
    );
    const p = rows[0];
    if (!p || p.user_id !== a.userId || !p.phone_device_id || !p.mac_device_id) return { code: 'forbidden' };
    if (
      role === 'mac'
        ? p.mac_device_id !== a.sender
        : !['m2p', 'p2m'].includes(a.dir) ||
          (role === 'sender'
            ? (a.dir === 'm2p' ? p.mac_device_id : p.phone_device_id) !== a.sender
            : (a.dir === 'm2p' ? p.phone_device_id : p.mac_device_id) !== a.receiver)
    )
      return { code: 'forbidden' };
    if (p.revoked) return { code: 'forbidden' };
    if (epoch && (!p.epoch || p.epoch !== a.epoch)) return { code: 'retired' };
    return { code: 'ok', epoch: p.epoch ?? undefined };
  }

  async enqueue(f) {
    if (
      !f ||
      typeof f !== 'object' ||
      !['m2p', 'p2m'].includes(f.dir) ||
      !Number.isSafeInteger(f.ctr) ||
      f.ctr < 1 ||
      !Buffer.isBuffer(f.nonce) ||
      !Buffer.isBuffer(f.box) ||
      !f.nonce.length ||
      !f.box.length ||
      f.nonce.length > 64 ||
      f.box.length > 256 * 1024 ||
      !Number.isSafeInteger(f.maxFrames) ||
      f.maxFrames < 1 ||
      !Number.isSafeInteger(f.maxBytes) ||
      f.maxBytes < 1 ||
      !Number.isSafeInteger(f.accountMaxFrames ?? 1) ||
      !Number.isSafeInteger(f.accountMaxBytes ?? 1) ||
      !Number.isSafeInteger(f.now) ||
      !Number.isSafeInteger(f.ttlMs) ||
      f.ttlMs < 1 ||
      !Number.isSafeInteger(f.now + f.ttlMs) ||
      !Number.isFinite(new Date(f.now + f.ttlMs).getTime())
    )
      return { code: 'invalid' };
    f = { ...f, nonce: Buffer.from(f.nonce), box: Buffer.from(f.box) };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, f, 'sender');
      if (g.code !== 'ok') return { code: g.code };
      // what the decision needs, in one round trip: the frame with this counter if it exists, the stream's high-water mark, whether the
      // mark jumped over this counter, the pair's usage and what the pairs of its account hold together
      const { rows } = await tx.query(
        `SELECT f.id, f.nonce, f.box, f.expires_at,
           (SELECT highwater FROM remote_durable.streams WHERE pair_id = $1 AND dir = $2) AS highwater,
           EXISTS (SELECT 1 FROM remote_durable.gaps WHERE pair_id = $1 AND dir = $2 AND $3 BETWEEN lo AND hi) AS skipped,
           (SELECT count(*)::int FROM remote_durable.frames WHERE pair_id = $1) AS n,
           (SELECT coalesce(sum(octet_length(nonce) + octet_length(box)), 0)::bigint FROM remote_durable.frames WHERE pair_id = $1) AS bytes,
           (SELECT count(*)::int FROM remote_durable.frames WHERE pair_id IN (SELECT pair_id FROM public.relay_pairs WHERE user_id = $4)) AS account_n,
           (SELECT coalesce(sum(octet_length(nonce) + octet_length(box)), 0)::bigint FROM remote_durable.frames
              WHERE pair_id IN (SELECT pair_id FROM public.relay_pairs WHERE user_id = $4)) AS account_bytes
         FROM (SELECT 1) one LEFT JOIN remote_durable.frames f ON f.pair_id = $1 AND f.dir = $2 AND f.ctr = $3`,
        [f.pairId, f.dir, f.ctr, f.userId],
      );
      const row = rows[0];
      if (row.id) {
        if (new Date(row.expires_at).getTime() <= f.now) return { code: 'expired' };
        return Buffer.from(row.nonce).equals(f.nonce) && Buffer.from(row.box).equals(f.box)
          ? { code: 'duplicate', id: row.id }
          : { code: 'conflict' };
      }
      const behind = row.highwater !== null && BigInt(f.ctr) <= BigInt(row.highwater);
      // at or below the mark with no frame: acknowledged and gone, unless the mark jumped over it (then it was never stored)
      if (behind && !row.skipped) return { code: 'expired' };
      if (f.relayFull) return { code: 'full', scope: 'relay' };
      // the account's own quota, across its pairs: it is refused before it can use up what the relay holds for everyone. Two pairs of one
      // account storing at the same moment can each pass (the lock is the pair's), so the quota may be passed by a frame per connection
      const size = f.nonce.length + f.box.length;
      if (row.account_n >= (f.accountMaxFrames ?? Infinity) || Number(row.account_bytes) + size > (f.accountMaxBytes ?? Infinity))
        return { code: 'full', scope: 'account' };
      if (row.n >= f.maxFrames || Number(row.bytes) + f.nonce.length + f.box.length > f.maxBytes) return { code: 'full' };
      const id = randomUUID();
      const frame = [id, f.pairId, f.dir, f.ctr, f.nonce, f.box, new Date(f.now + f.ttlMs)];
      if (behind) {
        // a skipped counter: the frame goes in and its gap is split around it, in one statement (the mark stays)
        await tx.query(
          `WITH stored AS (INSERT INTO remote_durable.frames (id,pair_id,dir,ctr,nonce,box,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id),
           gap AS (DELETE FROM remote_durable.gaps WHERE pair_id = $2 AND dir = $3 AND $4 BETWEEN lo AND hi RETURNING lo, hi)
           INSERT INTO remote_durable.gaps (pair_id,dir,lo,hi)
             SELECT $2, $3, lo, $4 - 1 FROM gap WHERE lo < $4 UNION ALL SELECT $2, $3, $4 + 1, hi FROM gap WHERE hi > $4`,
          frame,
        );
      } else {
        // the frame, the gap it jumps over (if any; a cold stream's mark counts as 0, so a refused counter 1 is a gap too, #3762) and the stream's new high-water mark are written by one statement
        await tx.query(
          `WITH stored AS (INSERT INTO remote_durable.frames (id,pair_id,dir,ctr,nonce,box,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id),
           gap AS (INSERT INTO remote_durable.gaps (pair_id,dir,lo,hi) SELECT $2, $3, coalesce($8::bigint, 0) + 1, $4 - 1 WHERE coalesce($8::bigint, 0) + 1 < $4)
           INSERT INTO remote_durable.streams (pair_id,dir,highwater) VALUES ($2,$3,$4)
           ON CONFLICT (pair_id,dir) DO UPDATE SET highwater = EXCLUDED.highwater
           RETURNING (SELECT id FROM stored) AS id`,
          [...frame, row.highwater],
        );
      }
      return { code: 'stored', id };
    });
  }

  async ack(a) {
    if (
      typeof a?.id !== 'string' ||
      !Number.isSafeInteger(a?.ctr) ||
      a.ctr < 1 ||
      !Number.isSafeInteger(a?.now) ||
      !Number.isFinite(new Date(a.now).getTime())
    )
      return { code: 'invalid' };
    a = { ...a };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, a, 'receiver');
      if (g.code !== 'ok') return { code: g.code };
      const frame = await tx.query(
        'SELECT expires_at FROM remote_durable.frames WHERE id::text = $1 AND pair_id = $2 AND dir = $3 AND ctr = $4',
        [a.id, a.pairId, a.dir, a.ctr],
      );
      if (frame.rows.length && new Date(frame.rows[0].expires_at).getTime() <= a.now) return { code: 'expired' };
      const result = await tx.query(
        `WITH gone AS (DELETE FROM remote_durable.gaps WHERE pair_id = $2 AND dir = $3 AND hi < $4)
         DELETE FROM remote_durable.frames WHERE id::text = $1 AND pair_id = $2 AND dir = $3 AND ctr = $4 RETURNING id`,
        [a.id, a.pairId, a.dir, a.ctr],
      );
      return { code: result.rows.length ? 'acked' : 'gone' };
    });
  }

  async waiting(a) {
    if (!Number.isSafeInteger(a?.now) || !Number.isFinite(new Date(a.now).getTime())) return { code: 'invalid', frames: [] };
    a = { ...a };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, a, 'receiver', { lock: false });
      if (g.code !== 'ok') return { code: g.code, frames: [] };
      const frames = await tx.query(
        'SELECT id,ctr,nonce,box,expires_at FROM remote_durable.frames WHERE pair_id = $1 AND dir = $2 ORDER BY ctr LIMIT 1',
        [a.pairId, a.dir],
      );
      if (frames.rows.length && new Date(frames.rows[0].expires_at).getTime() <= a.now) return { code: 'expired', frames: [] };
      return { code: 'ok', frames: frames.rows };
    });
  }

  async expire(pairId, epoch, now) {
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) return { code: 'invalid' };
    return this.transaction(async (tx) => {
      const pair = await tx.query(
        'SELECT e.epoch FROM public.relay_pairs p LEFT JOIN remote_durable.epochs e ON e.pair_id = p.pair_id WHERE p.pair_id = $1 FOR UPDATE OF p',
        [pairId],
      );
      if (!pair.rows.length) return { code: 'gone' };
      if (pair.rows[0].epoch !== epoch) return { code: 'retired' };
      const expired = await tx.query('DELETE FROM remote_durable.frames WHERE pair_id = $1 AND expires_at <= $2 RETURNING dir, ctr', [
        pairId,
        new Date(now),
      ]);
      for (const frame of expired.rows)
        await tx.query(
          'INSERT INTO remote_durable.drops (id,pair_id,dir,first_ctr,last_ctr,dropped,at) VALUES ($1,$2,$3,$4,$4,1,$5) ON CONFLICT (pair_id,dir) DO UPDATE SET id = EXCLUDED.id, first_ctr = LEAST(remote_durable.drops.first_ctr,EXCLUDED.first_ctr), last_ctr = GREATEST(remote_durable.drops.last_ctr,EXCLUDED.last_ctr), dropped = remote_durable.drops.dropped + 1, at = EXCLUDED.at',
          [randomUUID(), pairId, frame.dir, frame.ctr, new Date(now)],
        );
      return { code: 'ok', count: expired.rows.length };
    });
  }

  /** Live frames of one direction after `afterCtr`, oldest first; they stay stored until the receiver acknowledges them. */
  async deliverable(a) {
    if (!Number.isSafeInteger(a?.now) || !Number.isSafeInteger(a?.afterCtr) || !Number.isSafeInteger(a?.limit) || a.limit < 1)
      return { code: 'invalid', frames: [] };
    a = { ...a };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, a, 'receiver', { lock: false });
      if (g.code !== 'ok') return { code: g.code, frames: [] };
      const frames = await tx.query(
        'SELECT id,ctr,nonce,box FROM remote_durable.frames WHERE pair_id = $1 AND dir = $2 AND ctr > $3 AND expires_at > $4 ORDER BY ctr LIMIT $5',
        [a.pairId, a.dir, a.afterCtr, new Date(a.now), a.limit],
      );
      return { code: 'ok', frames: frames.rows };
    });
  }

  /** The receiver's acknowledgement by direction and counter (the frame id is the relay's own, a client never has it). */
  async ackByCtr(a) {
    if (!Number.isSafeInteger(a?.ctr) || a.ctr < 1 || !Number.isSafeInteger(a?.now) || !Number.isFinite(new Date(a.now).getTime()))
      return { code: 'invalid' };
    a = { ...a };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, a, 'receiver');
      if (g.code !== 'ok') return { code: g.code };
      // an acknowledged frame that is still live goes in one statement, with the gaps behind it (the receiver can no longer open a
      // frame there); only a miss looks again, to tell an expired frame from a gone one
      const deleted = await tx.query(
        `WITH gone AS (DELETE FROM remote_durable.gaps WHERE pair_id = $1 AND dir = $2 AND hi < $3)
         DELETE FROM remote_durable.frames WHERE pair_id = $1 AND dir = $2 AND ctr = $3 AND expires_at > $4 RETURNING id`,
        [a.pairId, a.dir, a.ctr, new Date(a.now)],
      );
      if (deleted.rows.length) return { code: 'acked' };
      const left = await tx.query('SELECT 1 FROM remote_durable.frames WHERE pair_id = $1 AND dir = $2 AND ctr = $3', [
        a.pairId,
        a.dir,
        a.ctr,
      ]);
      return { code: left.rows.length ? 'expired' : 'gone' };
    });
  }

  /** Deletes every frame stored for the pairs of one account (its relay access was switched off); resolves how many. The streams keep their marks, so a resend of one is answered as consumed. */
  async clearAccount(userId) {
    return this.transaction(async (tx) => {
      const { rows } = await tx.query(
        'DELETE FROM remote_durable.frames WHERE pair_id IN (SELECT pair_id FROM public.relay_pairs WHERE user_id = $1) RETURNING 1',
        [userId],
      );
      return rows.length;
    });
  }

  /** What the mailbox holds across every pair, for the relay-wide quota. */
  async usage() {
    return this.transaction(async (tx) => {
      const { rows } = await tx.query(
        'SELECT count(*)::bigint AS frames, coalesce(sum(octet_length(nonce) + octet_length(box)), 0)::bigint AS bytes FROM remote_durable.frames',
      );
      return { frames: Number(rows[0].frames), bytes: Number(rows[0].bytes) };
    });
  }

  /** The pairs holding a frame past its TTL, with their current epoch, for the sweep to expire one pair at a time. */
  async dueExpiry(now) {
    if (!Number.isSafeInteger(now)) return [];
    return this.transaction(async (tx) => {
      const { rows } = await tx.query(
        'SELECT DISTINCT f.pair_id, e.epoch FROM remote_durable.frames f JOIN remote_durable.epochs e ON e.pair_id = f.pair_id WHERE f.expires_at <= $1',
        [new Date(now)],
      );
      return rows.map((r) => ({ pairId: r.pair_id, epoch: r.epoch }));
    });
  }

  async drops(a) {
    a = { ...a };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, a, 'sender', { lock: false });
      if (g.code !== 'ok') return { code: g.code, drops: [] };
      const drops = await tx.query(
        'SELECT id, first_ctr, last_ctr, dropped, at FROM remote_durable.drops WHERE pair_id = $1 AND dir = $2',
        [a.pairId, a.dir],
      );
      return { code: 'ok', drops: drops.rows };
    });
  }

  async ackDrop(a) {
    if (typeof a?.id !== 'string' || !Number.isSafeInteger(a?.ctr) || a.ctr < 1) return { code: 'invalid' };
    a = { ...a };
    return this.transaction(async (tx) => {
      const g = await this.#guard(tx, a, 'sender');
      if (g.code !== 'ok') return { code: g.code };
      const result = await tx.query(
        'DELETE FROM remote_durable.drops WHERE id::text = $1 AND pair_id = $2 AND dir = $3 AND last_ctr = $4 RETURNING id',
        [a.id, a.pairId, a.dir, a.ctr],
      );
      return { code: result.rows.length ? 'acked' : 'gone' };
    });
  }
}
