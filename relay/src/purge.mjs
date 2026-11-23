// An account deleted on mopilot.ai: everything the relay holds for the user goes.

import { createHash } from 'node:crypto';

/** @typedef {import('./hub.mjs').Hub} Hub */

/** The digest a purge token carries for its device ids (the account service computes the same): SHA-256 hex of the sorted ids joined by newlines. */
export const digestOf = (/** @type {string[]} */ ids) =>
  createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');

/**
 * Each of the account's devices is revoked (sockets closed, pairs removed, the Macs told), then whatever is left under the user id goes
 * (pairs of devices the list did not name, push tokens), and any socket still open for the user is closed. Running it again finds nothing.
 * @param {Hub} hub
 * @param {{ userId: string, deviceIds: string[] }} account
 * @returns {Promise<{ devices: number, pairs: number }>}
 */
export async function purgeAccount(hub, { userId, deviceIds }) {
  let removed = 0;
  for (const deviceId of deviceIds) removed += await hub.revoke({ userId, deviceId });
  const left = await hub.store.purgeUser(userId);
  for (const p of left) {
    hub.cache.drop(p.pairId, [p.macDeviceId, p.phoneDeviceId]);
    hub.mailbox?.forget(p.pairId);
    for (const id of [p.macDeviceId, p.phoneDeviceId]) {
      const peer = hub.conns.get(id ?? '');
      if (peer) await hub.send(peer, { t: 'event', ev: 'pair.removed', pair: p.pairId, reason: 'revoked' });
    }
  }
  for (const conn of [...hub.conns.values()]) {
    if (conn.identity.userId !== userId) continue;
    hub.conns.delete(conn.identity.deviceId);
    hub.presence.delete(conn.identity.deviceId);
    hub.drop(conn, 4403, 'revoked');
  }
  const done = { devices: deviceIds.length, pairs: removed + left.length };
  hub.log('account_purged', done);
  return done;
}
