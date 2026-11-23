// One load run: start the relay, connect and pair N Macs with N phones, drive traffic and chaos on a timeline, wait for the
// mailbox to drain, and report what was lost, duplicated or reordered and how the relay held up.
import { PGlite } from '@electric-sql/pglite';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../relay/src/main.mjs';
import { Fleet } from './fleet.mjs';
import { ABUSE_PAIR_PREFIX, Resets } from './resets.mjs';
import { childRelay, inProcessRelay } from './relayHost.mjs';
import { Sampler } from './sampler.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @typedef {{ pairs: number, seconds: number, macRate: number, phoneRate: number, burst: { at: number, pairs: number, frames: number, size: number } | null, restarts: number, restartDownMs: number, allowRemoteDatabase: boolean, restartSignal: NodeJS.Signals, killRate: number, resetRate: number, database: string, drainSeconds: number, relayEnv: Record<string, string> }} LoadOptions */

/** @type {LoadOptions} */
export const DEFAULTS = {
  pairs: 500,
  seconds: 60,
  macRate: 0.5,
  phoneRate: 0.05,
  burst: { at: 0.3, pairs: 50, frames: 200, size: 4096 },
  restarts: 2,
  restartDownMs: 1500,
  restartSignal: 'SIGKILL',
  killRate: 2,
  resetRate: 0,
  database: '',
  allowRemoteDatabase: false,
  drainSeconds: 60,
  relayEnv: {},
};

/** The reset sockets' pair ids as a LIKE pattern (the underscore is escaped: it would match any character). */
const LIKE_ABUSE = `${ABUSE_PAIR_PREFIX.replace(/_/g, '\\_')}%`;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Empties the relay's tables so a run starts from nothing (a database the relay has not migrated yet has none). Only the relay's
 * own tables are touched, and only on this machine unless `allowRemote` says the database is a scratch one.
 */
async function truncate(/** @type {any} */ pool, /** @type {string} */ url, /** @type {boolean} */ allowRemote) {
  if (!allowRemote && !LOOPBACK.has(new URL(url).hostname)) {
    throw new Error(
      `refusing to truncate the relay's tables on ${new URL(url).hostname}: use a scratch database, or pass --allow-remote-database`,
    );
  }
  const { rows } = await pool.query(
    "SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE (schemaname = 'public' AND tablename LIKE 'relay\\_%') OR schemaname = 'remote_durable'",
  );
  if (rows.length) await pool.query(`TRUNCATE ${rows.map((/** @type {{ name: string }} */ r) => r.name).join(', ')} CASCADE`);
}

async function accountKeys() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    publicPem: await exportSPKI(publicKey),
    sign: (/** @type {string} */ user, /** @type {string} */ device, /** @type {'desktop' | 'phone'} */ kind) =>
      new SignJWT({ did: device, ...(kind === 'phone' && { dk: 'phone' }) })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('https://code.mopilot.ai')
        .setAudience('relay')
        .setSubject(user)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
        .sign(privateKey),
  };
}

/**
 * @param {Partial<LoadOptions>} given
 * @param {{ log?: (line: string) => void, makePool?: typeof createPool, bin?: string }} [deps] the pool and the relay script a child process runs are seams for tests
 */
export async function runLoad(given, { log = () => undefined, makePool = createPool, bin } = {}) {
  const o = { ...DEFAULTS, ...given };
  const keys = await accountKeys();
  const real = o.database !== '';
  const pool = real ? await makePool(o.database) : new PGlite();
  const env = { AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: o.database || 'postgres://unused', ...o.relayEnv };
  // the frames of the reset sockets' own pairs are not the fleet's: they may stay in the mailbox
  const depth = async () =>
    Number((await pool.query(`SELECT count(*) AS n FROM remote_durable.frames WHERE pair_id NOT LIKE '${LIKE_ABUSE}'`)).rows[0].n);
  const host = real ? await childRelay({ env, bin }) : await inProcessRelay({ env, pool });
  const fleet = new Fleet({ url: host.url, sign: keys.sign, pairs: o.pairs });
  const sampler = new Sampler({
    pid: () => host.pid,
    healthUrl: `${host.http}/healthz`,
    depth: () => depth(),
    sockets: () => fleet.socketsUp,
  });
  const resets = new Resets({ url: host.url, sign: keys.sign });
  const chaos = { socketsKilled: 0, relayRestarts: 0, resets: resets.done, resetsSkipped: 0, relayCrashes: 0 };
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  /** @type {Promise<unknown>[]} */
  const restarting = [];
  /** the first error a timeline step hit: it ends the run (a step that cannot run makes every number after it meaningless) */
  let failure = /** @type {Error | null} */ (null);
  const guarded = (/** @type {() => unknown} */ fn) => async () => {
    try {
      await fn();
    } catch (e) {
      failure ??= /** @type {Error} */ (e);
    }
  };
  const stopTimers = () => {
    for (const t of timers) clearTimeout(t), clearInterval(t);
  };
  try {
    if (real) await truncate(pool, o.database, o.allowRemoteDatabase);
    await host.start();
    log(`connecting ${o.pairs * 2} sockets`);
    await fleet.setup();
    sampler.begin();
    log('traffic');
    fleet.startTraffic({ macRate: o.macRate, phoneRate: o.phoneRate });
    const at = (/** @type {number} */ fraction, /** @type {() => unknown} */ fn) =>
      timers.push(setTimeout(guarded(fn), fraction * o.seconds * 1000));
    if (o.burst) {
      const { pairs, frames, size } = o.burst;
      at(o.burst.at, () => fleet.burst({ pairs: Math.min(pairs, o.pairs), frames, size }));
    }
    for (let i = 1; i <= o.restarts; i++) {
      at(i / (o.restarts + 1), () => {
        const restart = (async () => {
          log(`relay restart ${i} (${o.restartSignal})`);
          await host.kill(o.restartSignal);
          await sleep(o.restartDownMs);
          await host.start();
          chaos.relayRestarts++;
        })();
        restarting.push(restart);
        return restart;
      });
    }
    if (o.killRate > 0)
      timers.push(setInterval(() => (chaos.socketsKilled += fleet.killSockets(Math.max(1, Math.round(o.killRate)))), 1000));
    if (o.resetRate > 0) timers.push(setInterval(() => void resets.round(), 1000 / o.resetRate));
    const deadline = Date.now() + o.seconds * 1000;
    while (Date.now() < deadline && !failure) await sleep(Math.min(250, deadline - Date.now()));
    stopTimers();
    // a restart still in progress finishes before the drain, so the relay it brings back is the one measured
    await Promise.allSettled(restarting);
    await resets.idle();
    if (failure) throw failure;
    fleet.stopTraffic();
    log('draining');
    const drained = await fleet.drain(o.drainSeconds * 1000, depth);
    await sampler.sample();
    sampler.end();
    chaos.resetsSkipped = resets.skipped;
    chaos.relayCrashes = 'crashes' in host ? host.crashes : 0;
    const left = await depth();
    // an unreadable mailbox leaves every unreceived frame counted as lost rather than as undelivered, and the report says so
    let held = /** @type {Set<string>} */ (new Set());
    let mailboxKnown = true;
    try {
      const { rows } = await pool.query(`SELECT pair_id, dir, ctr FROM remote_durable.frames WHERE pair_id NOT LIKE '${LIKE_ABUSE}'`);
      held = new Set(
        rows.map(
          (/** @type {{ pair_id: string, dir: string, ctr: string | number }} */ x) =>
            `${Number(x.pair_id.slice(6))}:${x.dir}:${Number(x.ctr)}`,
        ),
      );
    } catch {
      mailboxKnown = false;
    }
    return {
      config: { pairs: o.pairs, sockets: o.pairs * 2, seconds: o.seconds },
      mode: real ? 'child process + Postgres' : 'in-process + PGlite',
      drained,
      mailboxLeft: left,
      mailboxKnown,
      chaos,
      samples: sampler.summary(),
      relayCloseCodes: 'closeCodes' in host ? host.closeCodes : undefined,
      relayEvents: 'events' in host ? host.events : undefined,
      relayErrorSamples: 'errorSamples' in host ? host.errorSamples : undefined,
      ...fleet.report(held),
    };
  } finally {
    stopTimers();
    sampler.end();
    fleet.stop();
    await host.stop().finally(() => (pool.end ?? pool.close).call(pool));
  }
}
