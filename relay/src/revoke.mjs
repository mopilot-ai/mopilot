// A device revoked on mopilot.ai (POST /v1/revoke, and each device of a purged account): what the relay held for it goes, its
// socket is closed with 4403, the peers of its pairs are told, and the Hosts it issued lose their credentials.
import { revokeLane } from './hosts.mjs';

/** @typedef {import('./hub.mjs').Hub} Hub */

/**
 * A device was revoked on mopilot.ai: forget what it held, close its socket and tell the peers of its pairs; the Hosts it issued
 * lose their credentials. Resolves how many pairs it removed.
 * @param {Hub} hub @param {{ userId: string, deviceId: string }} who
 */
export async function revokeDevice(hub, { userId, deviceId }) {
  const live = hub.conns.get(deviceId);
  const affected = live && live.identity.userId !== userId ? null : await hub.store.revokeDevice({ userId, deviceId, now: hub.now() });
  if (!affected) return 0;
  hub.cache.drop('-', [deviceId]);
  for (const a of affected) {
    hub.cache.drop(a.pairId, [a.peerDeviceId]);
    hub.mailbox?.forget(a.pairId);
  }
  const conn = hub.conns.get(deviceId);
  hub.conns.delete(deviceId);
  hub.presence.delete(deviceId);
  if (conn) hub.drop(conn, 4403, 'revoked');
  for (const a of affected) {
    const peer = hub.conns.get(a.peerDeviceId ?? '');
    if (peer) await hub.send(peer, { t: 'event', ev: 'pair.removed', pair: a.pairId, reason: 'revoked' });
  }
  // a phone whose Mac was revoked may have no pair left; it then loses its token (a revoked phone's was already deleted)
  for (const a of affected) await hub.pushCleanup(a.pairId, a.peerDeviceId);
  await revokeLane(hub, { userId, deviceId });
  hub.log('revoke', { device: deviceId, pairs: affected.length });
  return affected.length;
}
