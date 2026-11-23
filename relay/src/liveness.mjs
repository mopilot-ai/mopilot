// The hub's two periodic jobs: the ping round (end sockets that stopped answering or whose token ran out) and the mailbox
// sweep (drop frames past their TTL and tell their senders).

import { messageOf } from './processGuards.mjs';
import { isHostKind, peerChanged } from './hosts.mjs';

/** @typedef {import('./hub.mjs').Hub} Hub */

/** Every ping interval: ping each socket, end the ones that missed `missedPings`, and end the ones whose token ran out without a refresh. */
export function tickHub(/** @type {Hub} */ hub, /** @type {number} */ missedPings, /** @type {number} */ graceMs) {
  const now = hub.now();
  for (const conn of [...hub.conns.values()]) {
    if (now > conn.identity.expMs + graceMs) {
      hub.drop(conn, 4401, 'token_expired');
      afterTick(hub, conn, 4401);
    } else if (conn.paused) {
      // a socket the relay stopped reading cannot be heard answering a ping; it is judged again once it is read
      conn.missed = 0;
    } else if (conn.missed >= missedPings) {
      conn.socket.terminate();
      afterTick(hub, conn, 1006);
    } else {
      conn.missed++;
      try {
        conn.socket.ping();
      } catch {
        conn.missed = missedPings;
      }
    }
  }
  hub.push.prune(now);
  for (const buckets of [
    hub.pairBuckets,
    hub.frameBuckets,
    hub.receiptBuckets,
    hub.controlBuckets,
    hub.connectBuckets,
    hub.hostAuthBuckets,
    hub.hostAddressBuckets,
  ])
    buckets.prune();
}

/** Runs a connection's close handling behind whatever it is still doing. */
export function afterTick(/** @type {Hub} */ hub, /** @type {import('./connection.mjs').Conn} */ conn, /** @type {number} */ code) {
  conn.queue = conn.queue
    .then(() => hub.closed(conn, code))
    .catch((e) => hub.log('error', { device: conn.identity.deviceId, message: messageOf(e) }));
}

/** Drops expired mailbox frames and tells the senders (now, or when they next connect). */
export async function sweepHub(/** @type {Hub} */ hub) {
  for (const pairId of (await hub.mailbox?.sweep()) ?? []) {
    const pair = await hub.store.getPair(pairId);
    for (const [dir, id] of /** @type {const} */ ([
      ['m2p', pair?.macDeviceId],
      ['p2m', pair?.phoneDeviceId],
    ])) {
      const sender = hub.conns.get(String(id));
      if (sender) await hub.deliverDurableDrops(sender, pairId, dir);
    }
  }
  for (const d of await hub.store.sweepExpired(hub.now())) {
    const pair = await hub.store.getPair(d.pairId);
    if (!pair) continue;
    const sender = hub.conns.get(String(d.dir === 'm2p' ? pair.macDeviceId : pair.phoneDeviceId));
    if (sender) await hub.deliverDrops(sender, d.pairId, d.dir);
  }
  // pairs nobody joined are forgotten: the cached rows of them go too
  try {
    await hub.store.sweepPendingPairs(hub.now());
    await hub.store.sweepRevoked(hub.now());
  } finally {
    hub.cache.clear();
  }
}

/** Stops the hub: see Hub.shutdown. */
export async function shutdownHub(/** @type {Hub} */ hub, /** @type {number} */ graceMs) {
  hub.draining = true;
  const deadline = Date.now() + graceMs;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const expired = new Promise((resolve) => (timer = setTimeout(resolve, graceMs)));
  // a handler that finishes may start a delivery, which may be waited on in turn: look again until nothing is left or time runs out
  const settled = (async () => {
    for (;;) {
      const busy = [...hub.all].flatMap((c) => [c.queue, ...c.kicks]);
      await Promise.allSettled(busy);
      if (Date.now() >= deadline || ![...hub.all].some((c) => c.kicks.size)) return;
    }
  })();
  await Promise.race([settled, expired]);
  clearTimeout(timer);
  for (const c of hub.all) hub.drop(c, 1012, 'restarting');
  hub.conns.clear();
}

/** The close codes the relay and the standard use; any other is a client's own choice and must not make a series each. */
const KNOWN_CLOSE = new Set([1000, 1001, 1005, 1006, 1008, 1009, 1011, 1012, 1013, 4000, 4401, 4403, 4423, 4429, 4500, 4503]);
const closeLabel = (/** @type {number} */ code) => (KNOWN_CLOSE.has(code) ? String(code) : 'other');

/**
 * Handles a socket's close. The connection stays in `hub.all` until this has finished, so a shutdown waits for the database
 * work a closing Mac still has (its presence, the offline push) instead of ending the pool under it.
 * @param {Set<number>} clean close codes a Mac sends on purpose
 */
export async function closeHub(
  /** @type {Hub} */ hub,
  /** @type {import('./connection.mjs').Conn} */ conn,
  /** @type {number} */ code,
  clean,
) {
  try {
    conn.closed = true;
    const { deviceId, kind } = conn.identity;
    hub.metrics.inc(
      'relay_closes_total',
      { code: closeLabel(code) },
      1,
      'Sockets closed, by close code (a code a client chose is counted as client)',
    );
    if (hub.conns.get(deviceId) !== conn) return;
    hub.conns.delete(deviceId);
    hub.log('close', { device: deviceId, code });

    // the other end of a Host pair, and a phone's Mac, is told this end went (a shutdown tells nobody: everyone reconnects)
    if ((isHostKind(kind) || kind === 'phone') && !hub.draining) await peerChanged(hub, conn, await hub.pairsOf(deviceId), false);
    // sockets closed by a shutdown say nothing about their Macs: the relay is going, not they
    if (kind !== 'desktop' || hub.draining) return;
    // a Mac that said it was sleeping stays "sleeping"; otherwise it is gone, and a Mac that vanished raises machineOffline
    if (hub.presence.get(deviceId)?.state === 'sleeping') return;
    hub.presence.delete(deviceId);
    await hub.broadcastPresence(deviceId);
    if (clean.has(code) || (code >= 4000 && code < 5000)) return;
    for (const p of await hub.store.phonesOfMac(deviceId)) {
      await hub.push.request({ pairId: p.pairId, phoneDeviceId: /** @type {string} */ (p.phoneDeviceId) }, 'machineOffline', p.pairId);
    }
  } finally {
    hub.all.delete(conn);
  }
}

/**
 * Whether a device may connect now: null, or why not. Sockets still starting count, closed ones do not, and a device that
 * already has a socket replaces it, so its own old socket never counts against a cap.
 * @param {Hub} hub @param {import('./connection.mjs').Identity} identity @param {import('./connection.mjs').Conn | null} self the connection asking, when it is already part of the hub
 * @returns {'restarting' | 'busy' | 'account_limit' | null}
 */
export function refusalFor(hub, identity, self) {
  if (hub.draining) return 'restarting';
  const others = [...hub.all].filter((c) => c !== self && !c.closed && !c.gone && c.identity.deviceId !== identity.deviceId);
  if (others.length >= hub.limits.maxConnections) return 'busy';
  // a Host's socket is bounded by the account's Host cap (host.register), not the device cap
  if (identity.kind === 'host') return null;
  const own = others.filter((c) => c.identity.userId === identity.userId && c.identity.kind !== 'host').length;
  return own >= hub.limits.maxConnectionsPerAccount ? 'account_limit' : null;
}
