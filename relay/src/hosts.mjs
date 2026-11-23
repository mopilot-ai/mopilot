// MoPilot Hosts on the relay (#2709). A Host dials out with the credential an app issued for it (`mh1.<host>.<secret>`; the
// relay keeps only the secret's SHA-256), and the app reaches it on its host lane: the same account token on `/v1/ws?as=hostlink`,
// under its own relay id `<device>~h`, so it never replaces the socket of the phone lane. Host frames are live only: never
// stored, refused with `peer_offline` when the other end is not connected, and each end is told when the other comes or goes.
import { createHash, timingSafeEqual } from 'node:crypto';
import { encodeFrame, isPairId } from './frames.mjs';

/** @typedef {import('./hub.mjs').Hub} Hub */
/** @typedef {import('./connection.mjs').Conn} Conn */
/** @typedef {import('./connection.mjs').Identity} Identity */

const HOST_ID = /^h_[A-Za-z0-9_-]{16,64}$/;
const TOKEN = /^mh1\.(h_[A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43,128})$/;
const HASH = /^[0-9a-f]{64}$/;
/** What a host lane's relay id adds to the app's device id. */
export const LANE_SUFFIX = '~h';

/** @param {string | undefined} kind */
export const isHostKind = (kind) => kind === 'host' || kind === 'hostlink';

/** The token a Host sends: `mh1.<host id>.<secret>`; anything else is not one. @param {string} token */
export const isHostToken = (token) => token.startsWith('mh1.');

/** An app's account identity on its host lane. @param {Identity} identity @returns {Identity} */
export const laneOf = (identity) => ({
  ...identity,
  deviceId: identity.deviceId + LANE_SUFFIX,
  baseDeviceId: identity.deviceId,
  kind: 'hostlink',
});

/** The device whose revocation ends this identity: a host lane ends with its app's device. @param {Identity} identity */
export const revocableId = (identity) => identity.baseDeviceId ?? identity.deviceId;

/**
 * A refreshed account token on an open socket: the same identity, on the same lane, or null.
 * @param {Identity} current @param {Identity | null} next
 */
export function refreshed(current, next) {
  if (!next || current.kind === 'host') return null;
  const same = current.kind === 'hostlink' ? laneOf(next) : next;
  return same.deviceId === current.deviceId && same.userId === current.userId && same.kind === current.kind ? same : null;
}

/**
 * The identity of a Host's credential; `revoked` for a well-formed one the relay does not hold (removed, or never issued), which
 * the upgrade answers by closing the socket with 4403 so the Host's link learns it for good (a refused upgrade reads to a WebSocket
 * client as a bare network error, so it would dial again for ever); null for a token that is not one. Failed tries are limited per
 * remote address and Host id, so a Host whose credential is gone cannot lock out the others behind the same address: past the burst
 * a caller is refused (`limited`) before the database is asked.
 * @param {Hub} hub @param {string} token @param {string} address
 * @returns {Promise<Identity | null | 'limited' | 'revoked'>}
 */
export async function verifyHost(hub, token, address) {
  const m = TOKEN.exec(token);
  const bucket = hub.hostAuthBuckets.get(`${address}|${m?.[1] ?? ''}`);
  // the address as a whole too: a caller that makes up a new Host id for every try is held at the address's wider limit
  const wide = hub.hostAddressBuckets.get(address);
  if (bucket.take(0) > 0 || wide.take(0) > 0) return 'limited';
  const row = m ? await hub.hosts.get(m[1]) : null;
  const hash = createHash('sha256')
    .update(m?.[2] ?? '')
    .digest();
  if (!m || !row || row.secretHash.length !== hash.length || !timingSafeEqual(row.secretHash, hash)) {
    bucket.take(1);
    wide.take(1);
    return m ? 'revoked' : null;
  }
  return { userId: row.userId, deviceId: row.hostId, kind: 'host', expMs: Number.MAX_SAFE_INTEGER, ip: address };
}

/** Whether a Host's credential is gone (revoked while its socket was starting). @param {Hub} hub @param {Identity} identity */
export async function hostGone(hub, identity) {
  return identity.kind === 'host' && !(await hub.hosts.get(identity.deviceId));
}

/**
 * Tells the other end of each pair that this end came or went (a phone's Mac too: its hello says `peerEvents`, so its peerOnline stays current).
 * @param {Hub} hub @param {Conn} conn @param {{ pairId: string, macDeviceId: string, phoneDeviceId: string | null }[]} pairs @param {boolean} online
 */
export async function peerChanged(hub, conn, pairs, online) {
  const { deviceId, kind } = conn.identity;
  if (kind === 'host' && online) await hub.hosts.touch(deviceId, hub.now());
  // a lane that went can answer no boot download any more
  if (kind === 'hostlink' && !online) hub.boots.laneGone(deviceId);
  for (const p of pairs) {
    // a Host pair is joined from the start: both ends are set
    const peer = hub.conns.get(String(p.macDeviceId === deviceId ? p.phoneDeviceId : p.macDeviceId));
    // the app is told where its Host connected from (Add by command shows it before Allow); a Host is told nothing of the app
    const ip = kind === 'host' && online ? { ip: conn.identity.ip } : {};
    if (peer) await hub.send(peer, { t: 'event', ev: 'peer', pair: p.pairId, online, ...ip });
  }
}

/**
 * A frame on a Host pair: sent straight to the peer, never stored. A peer that is not connected (or whose socket did not take it)
 * is answered `peer_offline`; the endpoints then start a new session when it is back.
 * @param {Hub} hub @param {Conn} conn @param {{ pairId: string, dir: string, ctr: number, nonce: Buffer, box: Buffer }} f @param {string} peerId
 * @param {(code: string, extra?: object) => Promise<boolean>} fail
 */
export async function liveFrame(hub, conn, f, peerId, fail) {
  const peer = hub.conns.get(peerId);
  if (!peer || !(await hub.send(peer, encodeFrame(f.pairId, f.dir, f.ctr, f.nonce, f.box))))
    return void (await fail('peer_offline', { pair: f.pairId, ctr: f.ctr }));
  hub.metrics.inc('relay_frames_total', { dir: f.dir, via: 'live' }, 1, 'Frames the relay took from senders');
}

/** Closes a Host's socket and tells the app lane that the pair is gone. @param {Hub} hub @param {{ hostId: string, pairId: string }} h @param {string} laneId */
async function dropHost(hub, h, laneId) {
  hub.cache.drop(h.pairId, [h.hostId, laneId]);
  const conn = hub.conns.get(h.hostId);
  if (conn) {
    hub.conns.delete(h.hostId);
    hub.drop(conn, 4403, 'revoked');
  }
  const lane = hub.conns.get(laneId);
  if (lane) await hub.send(lane, { t: 'event', ev: 'pair.removed', pair: h.pairId, reason: 'revoked' });
}

/** An app device was revoked on mopilot.ai: the Hosts it issued lose their credentials, and its host lane is closed. @param {Hub} hub @param {{ userId: string, deviceId: string }} who */
export async function revokeLane(hub, { userId, deviceId }) {
  const laneId = deviceId + LANE_SUFFIX;
  for (const h of await hub.hosts.revokeOwner({ userId, ownerDeviceId: deviceId })) await dropHost(hub, h, laneId);
  const lane = hub.conns.get(laneId);
  if (lane && lane.identity.userId === userId) {
    hub.conns.delete(laneId);
    hub.drop(lane, 4403, 'revoked');
  }
}

/**
 * The host lane's requests: `host.register` { host, pair, hash } adds a Host's credential (at most `hostsPerAccount` per account),
 * `host.revoke` { host } removes one (the Host's socket is closed with 4403), `host.list` names the ones this app device issued.
 * @param {Hub} hub @param {Conn} conn @param {any} m @param {string | undefined} rid @param {(code: string, extra?: object) => Promise<boolean>} fail
 */
export async function hostControl(hub, conn, m, rid, fail) {
  const { userId, deviceId, kind } = conn.identity;
  if (kind !== 'hostlink') return void (await fail(m.t.startsWith('host.') ? 'forbidden' : 'bad_message'));
  const owner = revocableId(conn.identity);
  switch (m.t) {
    case 'host.register': {
      if (typeof m.host !== 'string' || !HOST_ID.test(m.host) || !isPairId(m.pair) || typeof m.hash !== 'string' || !HASH.test(m.hash))
        return void (await fail('bad_message'));
      const r = await hub.hosts.register({
        hostId: m.host,
        pairId: m.pair,
        userId,
        laneId: deviceId,
        ownerDeviceId: owner,
        secretHash: Buffer.from(m.hash, 'hex'),
        now: hub.now(),
        cap: hub.limits.hostsPerAccount,
      });
      hub.cache.drop(m.pair, [deviceId, m.host]);
      if (r !== 'ok') return void (await fail(r, { host: m.host }));
      return void (await hub.send(conn, { t: 'ok', op: 'host.register', host: m.host, pair: m.pair, rid }));
    }
    case 'host.revoke': {
      if (typeof m.host !== 'string' || !HOST_ID.test(m.host)) return void (await fail('bad_message'));
      const gone = await hub.hosts.revoke({ hostId: m.host, userId });
      // the lane told is the issuing app's, whichever of the account's devices asked
      if (gone) await dropHost(hub, gone, gone.laneId);
      hub.log('host_revoke', { device: owner, pairs: gone ? 1 : 0 });
      // a Host already gone is revoked too: the app retries a revoke until it is answered, so it must be safe to repeat
      return void (await hub.send(conn, { t: 'ok', op: 'host.revoke', host: m.host, removed: !!gone, rid }));
    }
    case 'host.boot': {
      const r = hub.boots.register(conn, m);
      if (r !== 'ok') return void (await fail(r, { boot: m.boot }));
      // `base`: where the command fetches the boot, when the relay serves boots on a host of their own (boot.mjs)
      return void (await hub.send(conn, {
        t: 'ok',
        op: 'host.boot',
        boot: m.boot,
        ...(hub.boots.origin && { base: hub.boots.origin }),
        rid,
      }));
    }
    case 'host.unboot':
      hub.boots.unregister(conn, m);
      return void (await hub.send(conn, { t: 'ok', op: 'host.unboot', rid }));
    case 'host.list': {
      const hosts = (await hub.hosts.ofOwner(userId, owner)).map((h) => ({
        host: h.hostId,
        pair: h.pairId,
        online: hub.conns.has(h.hostId),
        lastSeenAt: h.lastSeenAt,
      }));
      return void (await hub.send(conn, { t: 'ok', op: 'host.list', hosts, rid }));
    }
    default:
      return void (await fail('bad_message'));
  }
}

/**
 * `boot.data` from a host lane (boot.mjs): paced by the device's frame bucket, as a bundle is many messages; anything else is ignored.
 * @param {Hub} hub @param {Conn} conn @param {any} m
 */
export async function bootData(hub, conn, m) {
  if (conn.identity.kind !== 'hostlink') return;
  if (!(await hub.pace(conn, hub.frameBuckets.get(conn.identity.deviceId).take()))) return;
  hub.boots.data(conn, m);
}
