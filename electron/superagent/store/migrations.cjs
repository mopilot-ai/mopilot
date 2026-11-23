// Superagent store schema and forward-only migrations, versioned by PRAGMA user_version; a database from a newer app is refused, not touched.
// Tables: events (log + claim, pattern of open-swe openswe/event_claims.py), owed (open-swe openswe/webhooks/event_matches.py),
// outbox (karakeep-app/liteque src/queue.ts: leases, allocation id, idempotency key).

class StoreNewerError extends Error {
  constructor(found, known) {
    super(`The Superagent database is from a newer app (schema ${found}, this app knows ${known}). It was left untouched.`);
    this.name = 'StoreNewerError';
  }
}

/** One function per schema version; append, never edit a shipped one. */
const MIGRATIONS = [
  (db) =>
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        claim_owner TEXT,
        claim_expires_at INTEGER,
        committed_at INTEGER,
        done_at INTEGER,
        UNIQUE (source, external_id)
      );
      CREATE TABLE owed (
        ticket_id TEXT NOT NULL,
        event_id INTEGER NOT NULL REFERENCES events(id),
        owed_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        PRIMARY KEY (ticket_id, event_id)
      );
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        run_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        allocation_id TEXT,
        result TEXT,
        error TEXT
      );
    `),
  // S1: what the watcher keeps: settings, threads, triggers (sanitized, stored once) and the Gate's decisions with their marks
  (db) =>
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE threads (
        key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        meta TEXT NOT NULL
      );
      CREATE TABLE triggers (
        id TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id),
        source TEXT NOT NULL,
        thread_key TEXT NOT NULL REFERENCES threads(key),
        kind TEXT NOT NULL,
        actor_login TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        human INTEGER NOT NULL,
        text TEXT NOT NULL,
        url TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL UNIQUE REFERENCES triggers(id),
        thread_key TEXT NOT NULL,
        rule TEXT,
        mode TEXT,
        result TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        reason_text TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        at INTEGER NOT NULL,
        mark TEXT,
        marked_at INTEGER
      );
      CREATE INDEX decisions_rule_at ON decisions (rule, result, at);
    `),
];

const version = (db) => Number(/** @type {any} */ (db.prepare('PRAGMA user_version').get()).user_version);

/** Throws StoreNewerError for a database from a newer app, before anything about the file is changed. */
function assertKnown(db, migrations = MIGRATIONS) {
  const found = version(db);
  if (found > migrations.length) throw new StoreNewerError(found, migrations.length);
}

/**
 * Brings the database to the newest schema, each step in its own transaction that re-reads the version first, so a
 * second process that migrated meanwhile is not migrated over.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<(db: any) => void>} [migrations]
 */
function migrate(db, migrations = MIGRATIONS) {
  for (let step = 0; step < migrations.length; step++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      assertKnown(db, migrations);
      if (version(db) <= step) {
        migrations[step](db);
        db.exec(`PRAGMA user_version = ${step + 1}`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

module.exports = { MIGRATIONS, migrate, assertKnown, StoreNewerError };
