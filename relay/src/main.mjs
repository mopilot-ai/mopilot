// Starts the relay from the environment: config, Postgres pool and schema, the account verifier, the push path, the server.
import { createVerifier } from './auth.mjs';
import { messageOf } from './processGuards.mjs';
import { loadConfig } from './config.mjs';
import { Metrics } from './metrics.mjs';
import { createSender } from './pushSenders.mjs';
import { DurableStore, migrateDurable } from './durableStore.mjs';
import { transactionRunner } from './pgTransaction.mjs';
import { migrate, withMigrationLock } from './schema.mjs';
import { createRelay } from './server.mjs';

const PG = 'pg';

/**
 * `pg` is loaded here only, so the rest of the relay runs against any `{ query }` (the tests use an in-process Postgres).
 * A client the database drops while idle (a restart, a failover) emits `error` on the pool, which must be heard or it ends the process.
 * @param {string} url
 * @param {() => Promise<any>} [importPg]
 * @param {{ max?: number, statementTimeoutMs?: number, onError?: (e: Error) => void }} [o]
 */
export async function createPool(
  url,
  importPg = () => import(PG),
  {
    max = 10,
    statementTimeoutMs = 15_000,
    onError = (/** @type {Error} */ e) => console.error(JSON.stringify({ event: 'pool_error', message: messageOf(e) })),
  } = {},
) {
  const { default: pg } = await importPg();
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: statementTimeoutMs,
    keepAlive: true,
  });
  pool.on?.('error', onError);
  return pool;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ pool?: import('./store.mjs').Db, importPg?: Parameters<typeof createPool>[1], log?: (event: string, data: object) => void }} [deps]
 */
export async function start(env, deps = {}) {
  const config = loadConfig(env);
  const db =
    deps.pool ??
    (await createPool(config.databaseUrl, deps.importPg, {
      max: config.db.poolMax,
      statementTimeoutMs: config.db.statementTimeoutMs,
      ...(deps.log && { onError: (/** @type {Error} */ e) => deps.log?.('db_error', { message: messageOf(e) }) }),
    }));
  await withMigrationLock(db, async (conn) => {
    await migrate(conn);
    if (config.durable) await migrateDurable(conn);
  });
  const metrics = new Metrics();
  const send = createSender(config.push, { log: deps.log, metrics });
  const relay = createRelay({
    config,
    db,
    verifier: createVerifier(config.auth),
    send,
    metrics,
    log: deps.log,
    durable: config.durable ? new DurableStore(transactionRunner(db)) : null,
  });
  const port = await relay.listen();
  return {
    relay,
    port,
    config,
    /** Finishes what each connection is doing, closes the sockets with 1012 and, when the relay opened the pool itself, the pool. */
    async shutdown(/** @type {{ graceMs?: number }} */ { graceMs = config.shutdownMs } = {}) {
      await relay.shutdown({ graceMs });
      if (!deps.pool) await /** @type {any} */ (db).end?.();
    },
  };
}

/**
 * The process entry (bin.mjs): a bad config prints the reason and exits 1, with no stack trace to read through; SIGTERM and
 * SIGINT end the service the way `docker stop` expects (see Hub.shutdown), and a shutdown that hangs is cut off after its grace period.
 */
export async function run(
  /** @type {Record<string, string|undefined>} */ env,
  /** @type {Parameters<typeof start>[1] & { process?: { once(event: string, fn: () => void): unknown, exit(code: number): void } }} */ deps = {},
) {
  const log = (/** @type {string} */ event, /** @type {object} */ data) => console.log(JSON.stringify({ event, ...data }));
  try {
    const started = await start(env, { log, ...deps });
    log('listening', { port: started.port });
    const proc = deps.process ?? process;
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT']) {
      proc.once(signal, () => {
        if (stopping) return;
        stopping = true;
        log('shutdown', { signal });
        // the grace period plus a little for closing the pool; past that the process is ended rather than left hanging
        setTimeout(() => proc.exit(1), started.config.shutdownMs + 3000).unref();
        started.shutdown().then(
          () => log('stopped', {}),
          (e) => {
            console.error(`relay: shutdown failed: ${e.message}`);
            proc.exit(1);
          },
        );
      });
    }
    return started;
  } catch (e) {
    console.error(`relay: ${/** @type {Error} */ (e).message}`);
    process.exitCode = 1;
    return null;
  }
}
