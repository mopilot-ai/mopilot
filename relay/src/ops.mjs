// The relay's operations endpoints: /healthz (is the process up and the database answering), /readyz (should traffic be sent
// here: not while it is draining or the database is down) and /metrics (Prometheus text, off unless METRICS_TOKEN is set).
import { timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Metrics } from './metrics.mjs';
import { processErrors } from './processGuards.mjs';
import { REFUSAL_REASONS, REFUSED_HELP } from './access.mjs';
import { MAILBOX_SCOPES, countMailboxFull } from './durableMailbox.mjs';

/** How long a health answer is reused. */
const HEALTH_MS = 1000;
/** How long the counts that need a query (stored frames, joined pairs) are reused between scrapes. */
const COUNTS_MS = 10_000;

/** Whether the promise settles successfully within `ms`; the timer does not outlive it. */
const timed = (/** @type {Promise<unknown>} */ p, /** @type {number} */ ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms).unref();
    p.then(
      () => true,
      () => false,
    ).then((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });

/**
 * @param {object} o
 * @param {{ query(text: string): Promise<{ rows: any[] }> }} o.db
 * @param {import('./hub.mjs').Hub} o.hub
 * @param {Metrics} o.metrics
 * @param {string | undefined} o.metricsToken
 * @param {boolean} o.durable whether the durable mailbox is on (its frame counts exist)
 * @param {number} [o.healthTimeoutMs] how long the database may take to answer a health check before it counts as down
 * @param {() => number} [o.now]
 */
export function createOps({ db, hub, metrics, metricsToken, durable, healthTimeoutMs = 2000, now = Date.now }) {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  const startedAt = now();
  /** @type {{ at: number, frames: number, bytes: number, pairs: number, pending: number, disabled: number, accountBytes: number } | null} */
  let counts = null;
  /** @type {{ at: number, up: boolean } | null} */
  let health = null;
  /** @type {Promise<boolean> | null} */
  let checking = null;

  /**
   * Whether the database answers. Concurrent checks share one query and the answer is reused for a second, so a flood of
   * /healthz or /readyz requests costs the pool one connection, not one per request.
   */
  const databaseUp = async () => {
    if (health && now() - health.at < HEALTH_MS) return health.up;
    checking ??= timed(db.query('SELECT 1'), healthTimeoutMs)
      .then((up) => (health = { at: now(), up }).up)
      .finally(() => {
        checking = null;
      });
    return checking;
  };

  const readCounts = async () => {
    if (counts && now() - counts.at < COUNTS_MS) return counts;
    const pairs = (
      await db.query(
        'SELECT count(*) FILTER (WHERE phone_device_id IS NOT NULL) AS joined, count(*) FILTER (WHERE phone_device_id IS NULL) AS pending FROM relay_pairs',
      )
    ).rows[0];
    const stored = durable
      ? (
          await db.query(
            'SELECT count(*)::bigint AS frames, coalesce(sum(octet_length(nonce) + octet_length(box)), 0)::bigint AS bytes FROM remote_durable.frames',
          )
        ).rows[0]
      : (await db.query('SELECT count(*)::bigint AS frames, coalesce(sum(size), 0)::bigint AS bytes FROM relay_mailbox')).rows[0];
    const disabled = (await db.query('SELECT count(*) AS n FROM relay_disabled_accounts')).rows[0];
    // what the account holding the most stores: how close any one account is to its quota
    const top = (
      await db.query(
        `SELECT coalesce(max(bytes), 0)::bigint AS bytes FROM (
           SELECT sum(${durable ? 'octet_length(f.nonce) + octet_length(f.box)' : 'f.size'}) AS bytes
           FROM ${durable ? 'remote_durable.frames' : 'relay_mailbox'} f JOIN relay_pairs p ON p.pair_id = f.pair_id GROUP BY p.user_id) per_account`,
      )
    ).rows[0];
    counts = {
      at: now(),
      disabled: Number(disabled.n),
      accountBytes: Number(top.bytes),
      frames: Number(stored.frames),
      bytes: Number(stored.bytes),
      pairs: Number(pairs.joined),
      pending: Number(pairs.pending),
    };
    return counts;
  };

  /** How much of each process error count has been added to the counter already. */
  const counted = { unhandled_rejection: 0, uncaught_exception: 0 };

  /** Fills the gauges that are read at scrape time. */
  const gauges = async () => {
    for (const event of /** @type {const} */ (['unhandled_rejection', 'uncaught_exception'])) {
      metrics.inc(
        'relay_process_errors_total',
        { event },
        processErrors[event] - counted[event],
        'Stray rejections and dead-socket errors the guards survived (a fatal uncaught exception ends the process before a scrape: watch relay_uptime_seconds)',
      );
      counted[event] = processErrors[event];
    }
    const byKind = { desktop: 0, phone: 0, host: 0, hostlink: 0 };
    for (const c of hub.conns.values()) byKind[c.identity.kind]++;
    for (const [kind, n] of Object.entries(byKind))
      metrics.set('relay_connections', n, { kind }, 'Sockets connected now, by kind of device');
    // what the caps count: every socket the hub holds, the ones still starting too; a Host's is not one of its account's devices
    const held = [...hub.all].filter((c) => !c.closed && !c.gone);
    /** @type {Map<string, number>} */
    const perAccount = new Map();
    for (const c of held) if (c.identity.kind !== 'host') perAccount.set(c.identity.userId, (perAccount.get(c.identity.userId) ?? 0) + 1);
    metrics.set('relay_sockets', held.length, {}, 'Sockets the relay holds now, the ones still starting too (what MAX_CONNECTIONS caps)');
    metrics.set('relay_sockets_limit', hub.limits.maxConnections, {}, 'MAX_CONNECTIONS');
    metrics.set(
      'relay_account_sockets_max',
      Math.max(0, ...perAccount.values()),
      {},
      'Device sockets of the account that holds the most now',
    );
    metrics.set('relay_account_sockets_limit', hub.limits.maxConnectionsPerAccount, {}, 'MAX_CONNECTIONS_PER_ACCOUNT');
    metrics.set('relay_mailbox_frames_limit', hub.limits.globalMaxFrames, {}, 'MAILBOX_GLOBAL_MAX_FRAMES');
    metrics.set('relay_mailbox_bytes_limit', hub.limits.globalMaxBytes, {}, 'MAILBOX_GLOBAL_MAX_BYTES');
    metrics.set('relay_account_mailbox_bytes_limit', hub.limits.accountMaxBytes, {}, 'MAILBOX_ACCOUNT_MAX_BYTES');
    for (const scope of MAILBOX_SCOPES) countMailboxFull(metrics, scope, 0);
    for (const reason of REFUSAL_REASONS) metrics.inc('relay_connections_refused_total', { reason }, 0, REFUSED_HELP);
    metrics.set('relay_draining', hub.draining ? 1 : 0, {}, '1 while the relay is shutting down');
    metrics.set('relay_uptime_seconds', Math.round((now() - startedAt) / 1000), {}, 'Seconds since the relay started');
    metrics.set('relay_event_loop_lag_seconds', lag.percentile(99) / 1e9, {}, 'p99 event-loop delay since the last scrape');
    lag.reset();
    const memory = process.memoryUsage();
    metrics.set('process_resident_memory_bytes', memory.rss, {}, 'Resident memory of the relay process');
    metrics.set('process_heap_used_bytes', memory.heapUsed, {}, 'JavaScript heap in use (what a leak grows)');
    metrics.set(
      'process_external_memory_bytes',
      memory.external,
      {},
      'Buffers and other memory outside the JavaScript heap (array buffers are part of it)',
    );
    metrics.set(
      'process_cpu_seconds_total',
      process.cpuUsage().user / 1e6 + process.cpuUsage().system / 1e6,
      {},
      'CPU time used by the relay process',
    );
    try {
      const c = await readCounts();
      metrics.set('relay_pairs', c.pairs, { state: 'joined' }, 'Pairs in the database, by state');
      metrics.set('relay_pairs', c.pending, { state: 'pending' }, 'Pairs in the database, by state');
      metrics.set('relay_mailbox_frames', c.frames, {}, 'Sealed frames stored for an offline receiver');
      metrics.set('relay_mailbox_bytes', c.bytes, {}, 'Bytes of those frames');
      metrics.set('relay_accounts_disabled', c.disabled, {}, 'Accounts whose relay access is switched off');
      metrics.set('relay_account_mailbox_bytes_max', c.accountBytes, {}, 'Bytes stored for the account that stores the most');
      metrics.set('relay_database_up', 1, {}, '1 when the database answered the scrape');
    } catch {
      // the counts are unknown, not what they were: the series go until the database answers again
      for (const name of [
        'relay_pairs',
        'relay_mailbox_frames',
        'relay_mailbox_bytes',
        'relay_accounts_disabled',
        'relay_account_mailbox_bytes_max',
      ])
        metrics.series.delete(name);
      metrics.set('relay_database_up', 0, {}, '1 when the database answered the scrape');
    }
  };

  const text = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {string} */ body) =>
    void res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(body);

  /** @returns {Promise<boolean>} whether the request was one of these endpoints */
  async function handle(
    /** @type {import('node:http').IncomingMessage} */ req,
    /** @type {import('node:http').ServerResponse} */ res,
    /** @type {string} */ path,
  ) {
    if (req.method !== 'GET') return false;
    if (path === '/healthz') {
      const ok = await databaseUp();
      text(res, ok ? 200 : 503, ok ? 'ok' : 'database unavailable');
    } else if (path === '/readyz') {
      const reason = hub.draining ? 'draining' : (await databaseUp()) ? '' : 'database unavailable';
      text(res, reason ? 503 : 200, reason || 'ready');
    } else if (path === '/metrics' && metricsToken) {
      const given = Buffer.from(/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
      const want = Buffer.from(metricsToken);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        res.writeHead(401).end();
        return true;
      }
      await gauges();
      text(res, 200, metrics.render());
    } else return false;
    return true;
  }

  return { handle, start: () => lag.enable(), stop: () => lag.disable(), metrics };
}
