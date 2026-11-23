// The relay's Postgres schema. Zero knowledge is a property of these columns: the only free-form column is a frame's
// sealed `box` (and its `nonce`); everything else is an id, a direction, a counter, a size or a timestamp.

export const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS relay_pairs (
    pair_id text PRIMARY KEY,
    user_id text NOT NULL,
    mac_device_id text NOT NULL,
    phone_device_id text,
    join_deadline timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    joined_at timestamptz
  )`,
  'CREATE INDEX IF NOT EXISTS relay_pairs_mac ON relay_pairs (mac_device_id)',
  'CREATE INDEX IF NOT EXISTS relay_pairs_phone ON relay_pairs (phone_device_id)',
  // an account's pairs: what its mailbox quota and its pair cap are counted over, on every stored frame
  'CREATE INDEX IF NOT EXISTS relay_pairs_user ON relay_pairs (user_id)',
  `CREATE TABLE IF NOT EXISTS relay_mailbox (
    id bigserial PRIMARY KEY,
    pair_id text NOT NULL REFERENCES relay_pairs (pair_id) ON DELETE CASCADE,
    dir text NOT NULL CHECK (dir IN ('p2m', 'm2p')),
    ctr bigint NOT NULL,
    nonce bytea NOT NULL,
    box bytea NOT NULL,
    size integer NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS relay_mailbox_pair ON relay_mailbox (pair_id, dir, id)',
  'CREATE INDEX IF NOT EXISTS relay_mailbox_expiry ON relay_mailbox (expires_at)',
  `CREATE TABLE IF NOT EXISTS relay_drops (
    id bigserial PRIMARY KEY,
    pair_id text NOT NULL REFERENCES relay_pairs (pair_id) ON DELETE CASCADE,
    dir text NOT NULL CHECK (dir IN ('p2m', 'm2p')),
    dropped integer NOT NULL,
    first_ctr bigint NOT NULL,
    last_ctr bigint NOT NULL,
    at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS relay_push_tokens (
    device_id text PRIMARY KEY,
    user_id text NOT NULL,
    platform text NOT NULL CHECK (platform IN ('apns', 'fcm')),
    token text NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS relay_push_tokens_token ON relay_push_tokens (token)',
  // the APNs topic (the app) whose credential set last sent to this token successfully; null until then, so a relay holding several sets knows which to try first
  'ALTER TABLE relay_push_tokens ADD COLUMN IF NOT EXISTS topic text',
  // the push-to-update token of a phone's running Live Activity; it exists only while the person has the activity switched on
  `CREATE TABLE IF NOT EXISTS relay_activity_tokens (
    device_id text PRIMARY KEY,
    user_id text NOT NULL,
    token text NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  // the same memory for the activity token (the topic here is the app's bundle id, without the Live Activity suffix)
  'ALTER TABLE relay_activity_tokens ADD COLUMN IF NOT EXISTS topic text',
  `CREATE TABLE IF NOT EXISTS relay_revoked_devices (
    device_id text PRIMARY KEY,
    user_id text NOT NULL,
    revoked_at timestamptz NOT NULL
  )`,
  // an account whose relay access the account service switched off (POST /v1/account/access): the id and when, nothing else
  `CREATE TABLE IF NOT EXISTS relay_disabled_accounts (
    user_id text PRIMARY KEY,
    disabled_at timestamptz NOT NULL
  )`,
  // a Host's relay credential (#2709): the app device that issued it, the one pair it may carry frames on, and the SHA-256 of its secret
  `CREATE TABLE IF NOT EXISTS relay_hosts (
    host_id text PRIMARY KEY,
    user_id text NOT NULL,
    owner_device_id text NOT NULL,
    pair_id text NOT NULL UNIQUE REFERENCES relay_pairs (pair_id) ON DELETE CASCADE,
    secret_hash bytea NOT NULL,
    created_at timestamptz NOT NULL,
    last_seen_at timestamptz
  )`,
  'CREATE INDEX IF NOT EXISTS relay_hosts_user ON relay_hosts (user_id, owner_device_id)',
];

/** @param {{ query(text: string, params?: unknown[]): Promise<unknown> }} db */
export async function migrate(db) {
  for (const sql of STATEMENTS) await db.query(sql);
}

/** An arbitrary constant: every instance that migrates takes this advisory lock, so two starting together (a rolling restart, a second replica) run the statements one after the other. */
const MIGRATION_LOCK = 7_262_024_001;

/**
 * Runs `work` holding the migration lock. The lock belongs to a database session, so a pool is asked for one connection and
 * work runs on it; a single-connection database (PGlite) needs no connection of its own.
 * @param {any} db a `pg` Pool, or an object with `query`
 * @param {(conn: { query(text: string, params?: unknown[]): Promise<unknown> }) => Promise<void>} work
 */
export async function withMigrationLock(db, work) {
  const conn = typeof db.connect === 'function' ? await db.connect() : null;
  const session = conn ?? db;
  let failure;
  try {
    // a migration may run longer than the statement timeout a pooled connection carries, and a second instance waits on the lock for as long as the first one migrates
    await session.query('SET statement_timeout = 0');
    await session.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await work(session);
  } catch (e) {
    failure = e;
  }
  try {
    await session.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    await session.query('RESET statement_timeout');
    conn?.release();
  } catch (e) {
    // a session that cannot unlock or reset is destroyed, which releases the lock and drops its settings
    conn?.release(/** @type {Error} */ (e));
    failure ??= e;
  }
  if (failure) throw failure;
}
