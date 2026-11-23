// A transaction runner for the durable store over the relay's database: one dedicated connection per call, COMMIT only on success, ROLLBACK on any error.

/** @typedef {{ query(text: string, params?: unknown[]): Promise<unknown>, release: () => void }} Conn */

/**
 * @param {{ transaction?: <T>(work: (tx: any) => Promise<T>) => Promise<T>, connect?: () => Promise<Conn> }} db a `pg` Pool, or an in-process Postgres that has its own transaction()
 * @returns {import('./durableStore.mjs').TransactionRunner}
 */
export function transactionRunner(db) {
  const own = db.transaction;
  if (typeof own === 'function') return (work) => own.call(db, work);
  return async (work) => {
    const conn = await /** @type {() => Promise<Conn>} */ (db.connect)();
    let result;
    try {
      await conn.query('BEGIN');
      result = await work(/** @type {any} */ (conn));
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK').catch(() => undefined);
      conn.release();
      throw error;
    }
    conn.release();
    return result;
  };
}
