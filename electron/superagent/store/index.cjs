// The Superagent store: one node:sqlite file holding the event log, owed events and the outbox. No Electron imports; clock and database are injected.
const { openDatabase, acknowledgeDamage, StoreDamagedError } = require('./open.cjs');
const { migrate, assertKnown, StoreNewerError } = require('./migrations.cjs');
const { createEventLog } = require('./events.cjs');
const { createOwed } = require('./owed.cjs');
const { createOutbox } = require('./outbox.cjs');
const { createWatchStore } = require('./watch.cjs');
const { randomUUID } = require('node:crypto');

/**
 * Builds the store around an already opened and migrated database.
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {() => number} o.now
 * @param {() => string} [o.newId] allocation-id source, a random UUID by default
 * @param {(fn: () => void, ms: number) => () => void} [o.every] the claim heartbeat timer
 */
function createStore({ db, now, newId = randomUUID, every }) {
  let inTransaction = false;
  let open = true;
  /** @type {Set<Promise<unknown>>} */
  const inflight = new Set();

  /** Runs `work` in one transaction; a nested call joins the outer one. `work` must be synchronous: a returned promise is refused and rolled back. */
  function atomic(work) {
    if (inTransaction) return work();
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const out = work();
      if (typeof (/** @type {any} */ (out)?.then) === 'function') throw new TypeError('atomic() work must be synchronous');
      db.exec('COMMIT');
      inTransaction = false;
      return out;
    } catch (e) {
      inTransaction = false;
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        // the original error is the one the caller needs; the failed rollback travels with it
        /** @type {any} */ (e).rollbackError = rollbackError;
      }
      throw e;
    }
  }

  const log = createEventLog(db, { now, every, isOpen: () => open });
  /** Handlers in flight are tracked so a flag flip can wait for them before closing. */
  const handle = (...args) => {
    const run = log.handle(...args);
    inflight.add(run);
    const forget = () => inflight.delete(run);
    run.then(forget, forget);
    return run;
  };

  return {
    db,
    atomic,
    events: { ...log, handle },
    owed: createOwed(db, { now }),
    outbox: createOutbox(db, { now, newId }),
    watch: createWatchStore(db, { now }),
    /** Waits for running handlers, at most `timeoutMs`; one that outlives it is left (its claim expires or waits for reconcile). */
    async drain({ timeoutMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
      await Promise.race([Promise.allSettled([...inflight]), sleep(timeoutMs)]);
    },
    get isOpen() {
      return open;
    },
    close() {
      open = false;
      db.close();
    },
  };
}

/**
 * Opens the database file (see open.cjs for what a damaged one does) and builds the store.
 * @param {{ file: string, now: () => number, newId?: () => string, openDb?: (file: string) => any, fsOps: any, every?: (fn: () => void, ms: number) => () => void }} o
 */
function openStore({ file, now, newId, openDb, fsOps, every }) {
  const db = openDatabase({ file, now, openDb, fsOps, migrate, assertKnown });
  return createStore({ db, now, newId, every });
}

module.exports = { createStore, openStore, acknowledgeDamage, StoreDamagedError, StoreNewerError };
