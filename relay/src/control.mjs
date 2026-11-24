// The messages that are not frames or receipts: pairing (register, join, remove), a Mac's presence, and push (a phone's token and its Live Activity token,
// a Mac's request and its activity snapshot). Each takes the hub and the connection it came on; `fail` answers with an error carrying the request id.
import { PUSH_KINDS, isPairId } from './frames.mjs';
import { parseSnapshot } from './activity.mjs';
import { MAX_SEALED, MAX_SEALED_STAMP } from './pushPayload.mjs';
import { LANE_SUFFIX, hostControl, isHostKind } from './hosts.mjs';

/** What a sealed stamp is made of (base64url): anything else is not one the phone could open, and is refused rather than dropped. */
const STAMP_CHARS = /^[A-Za-z0-9_-]+$/;

/** The hex of an ActivityKit push-to-update token (32 bytes today); the bound leaves room for a longer one. */
const ACTIVITY_TOKEN = /^[0-9a-fA-F]{16,512}$/;

/**
 * Whom a push or activity request on `pairId` is for, or null when the sender may not ask. A Mac asks on a pair it registered, for the phone that
 * joined it. A Host asks on its own pair only (its id is the pair's phone side), for the phone behind the pair's lane (`<device>~h`): that
 * phone's device id, whose push token is the target. A Mac's lane has no token, so a Host's push can never reach a Mac; `token: false` says so.
 * @param {import('./hub.mjs').Hub} hub @param {import('./connection.mjs').Conn['identity']} identity @param {any} pairId
 * @returns {Promise<{ pairId: string, phoneDeviceId: string, token: boolean } | null>}
 */
async function pushTarget(hub, { deviceId, kind }, pairId) {
  const pair = isPairId(pairId) ? await hub.store.getPair(pairId) : null;
  if (!pair?.phoneDeviceId) return null;
  if (kind === 'desktop')
    return pair.macDeviceId === deviceId ? { pairId: pair.pairId, phoneDeviceId: pair.phoneDeviceId, token: true } : null;
  if (pair.phoneDeviceId !== deviceId || !pair.macDeviceId.endsWith(LANE_SUFFIX)) return null;
  const phoneDeviceId = pair.macDeviceId.slice(0, -LANE_SUFFIX.length);
  return { pairId: pair.pairId, phoneDeviceId, token: !!(await hub.store.pushTokenOf(phoneDeviceId)) };
}

/**
 * @param {import('./hub.mjs').Hub} hub @param {import('./connection.mjs').Conn} conn @param {any} m
 * @param {string | undefined} rid @param {(code: string, extra?: object) => Promise<boolean>} fail
 */
export async function control(hub, conn, m, rid, fail) {
  const { userId, deviceId, kind } = conn.identity;
  switch (m.t) {
    case 'pair.register': {
      if (kind !== 'desktop') return void (await fail('forbidden'));
      if (!isPairId(m.pair)) return void (await fail('bad_message'));
      const ok = await hub.store.registerPair({
        pairId: m.pair,
        userId,
        macDeviceId: deviceId,
        now: hub.now(),
        joinMs: hub.config.pairJoinMs,
      });
      hub.cache.drop(m.pair, [deviceId]);
      if (ok) return void (await hub.send(conn, { t: 'ok', op: 'pair.register', pair: m.pair, rid }));
      // a pair that is there is taken (or joined); one that is not was refused for the Mac's unjoined pairs already open
      return void (await fail((await hub.store.getPair(m.pair)) ? 'pair_exists' : 'pair_limit', { pair: m.pair }));
    }
    case 'pair.join': {
      if (kind !== 'phone') return void (await fail('forbidden'));
      if (!isPairId(m.pair)) return void (await fail('bad_message'));
      const r = await hub.store.joinPair({
        pairId: m.pair,
        userId,
        phoneDeviceId: deviceId,
        now: hub.now(),
        maxPairs: hub.limits.pairsPerAccount,
      });
      if (!r.ok) return void (await fail(r.code, { pair: m.pair }));
      hub.cache.drop(m.pair, [deviceId, r.macDeviceId]);
      await hub.send(conn, { t: 'ok', op: 'pair.join', pair: m.pair, rid, presence: hub.presenceOf(r.macDeviceId) });
      const mac = hub.conns.get(r.macDeviceId);
      if (mac) await hub.send(mac, { t: 'event', ev: 'pair.joined', pair: m.pair });
      return;
    }
    case 'pair.remove': {
      // a Host's pair goes with its credential (host.revoke), never on its own
      if (isHostKind(kind)) return void (await fail('forbidden'));
      const pair = isPairId(m.pair) ? await hub.store.getPair(m.pair) : null;
      if (!pair || (pair.macDeviceId !== deviceId && pair.phoneDeviceId !== deviceId))
        return void (await fail('unknown_pair', { pair: m.pair }));
      await hub.store.removePair(pair.pairId);
      hub.cache.drop(pair.pairId, [pair.macDeviceId, pair.phoneDeviceId]);
      hub.mailbox?.forget(pair.pairId);
      const peer = hub.conns.get((pair.macDeviceId === deviceId ? pair.phoneDeviceId : pair.macDeviceId) ?? '');
      if (peer) await hub.send(peer, { t: 'event', ev: 'pair.removed', pair: pair.pairId, reason: 'unpaired' });
      await hub.pushCleanup(pair.pairId, pair.phoneDeviceId);
      return void (await hub.send(conn, { t: 'ok', op: 'pair.remove', pair: pair.pairId, rid }));
    }
    case 'presence': {
      // on a Host pair it is only the heartbeat (relayClient.cjs): answered, never broadcast
      if (isHostKind(kind)) return void (await hub.send(conn, { t: 'ok', op: 'presence', rid }));
      if (kind !== 'desktop' || (m.state !== 'online' && m.state !== 'sleeping')) return void (await fail('bad_message'));
      hub.presence.set(deviceId, { state: m.state, at: hub.now() });
      await hub.broadcastPresence(deviceId);
      return void (await hub.send(conn, { t: 'ok', op: 'presence', rid }));
    }
    case 'push.register': {
      const token = m.token;
      if (kind !== 'phone') return void (await fail('forbidden'));
      if ((m.platform !== 'apns' && m.platform !== 'fcm') || typeof token !== 'string' || !token || token.length > 4096)
        return void (await fail('bad_message'));
      await hub.push.register({ deviceId, userId, platform: m.platform, token });
      return void (await hub.send(conn, { t: 'ok', op: 'push.register', rid }));
    }
    case 'push.unregister':
      if (kind !== 'phone') return void (await fail('forbidden'));
      await hub.push.unregister(deviceId);
      return void (await hub.send(conn, { t: 'ok', op: 'push.unregister', rid }));
    case 'activity.register': {
      if (kind !== 'phone') return void (await fail('forbidden'));
      if (typeof m.token !== 'string' || !ACTIVITY_TOKEN.test(m.token)) return void (await fail('bad_message'));
      await hub.push.registerActivity({ deviceId, userId, token: m.token });
      await hub.send(conn, { t: 'ok', op: 'activity.register', rid });
      // the state already held goes to the new activity after the answer; a provider that is slow holds nothing up
      return void hub.track(conn, hub.push.refreshActivity(deviceId));
    }
    case 'activity.unregister':
      if (kind !== 'phone') return void (await fail('forbidden'));
      await hub.push.unregisterActivity(deviceId);
      return void (await hub.send(conn, { t: 'ok', op: 'activity.unregister', rid }));
    case 'activity': {
      if (kind !== 'desktop' && kind !== 'host') return void (await fail('forbidden'));
      // a field this relay does not know is ignored (parseSnapshot reads the known ones); a malformed known field is refused
      const snapshot = parseSnapshot(m.state);
      if (!snapshot) return void (await fail('bad_message'));
      const target = await pushTarget(hub, conn.identity, m.pair);
      if (!target) return void (await fail('unknown_pair', { pair: m.pair }));
      const { pairId, phoneDeviceId } = target;
      if (!target.token) return void (await hub.send(conn, { t: 'push.result', pair: pairId, status: 'no_token', rid }));
      // answered like a push request (the Mac settles it by its request id), after the provider has answered
      hub.track(
        conn,
        hub.push.activity({ pairId, phoneDeviceId }, snapshot).then(
          (status) => hub.send(conn, { t: 'push.result', pair: pairId, status, rid }),
          (e) => fail('push_failed', { pair: pairId }).then(() => Promise.reject(e)),
        ),
      );
      return;
    }
    case 'push': {
      if (kind !== 'desktop' && kind !== 'host') return void (await fail('forbidden'));
      if (
        !PUSH_KINDS.includes(m.kind) ||
        (m.kind === 'cleared' && kind !== 'host') ||
        typeof m.ref !== 'string' ||
        !m.ref ||
        m.ref.length > 128
      )
        return void (await fail('bad_message'));
      if (m.sealed !== undefined && (typeof m.sealed !== 'string' || m.sealed.length > MAX_SEALED)) return void (await fail('bad_message'));
      // MoMo's card: an opaque handle like `ref`, forwarded unread
      if (m.card !== undefined && (typeof m.card !== 'string' || !m.card || m.card.length > 128)) return void (await fail('bad_message'));
      // MoMo's opt-in body, sealed for the phone: forwarded unread, like `sealed`
      if (m.sealedBody !== undefined && (typeof m.sealedBody !== 'string' || !m.sealedBody || m.sealedBody.length > MAX_SEALED))
        return void (await fail('bad_message'));
      // the lease of the MoMo home that sent it, sealed for the phone: forwarded unread, like `sealedBody`; the relay keeps no state about it and ignores it on any other kind
      const momo = m.kind === 'momoNeedsYou' || m.kind === 'cleared';
      if (
        momo &&
        m.sealedStamp !== undefined &&
        (typeof m.sealedStamp !== 'string' || !m.sealedStamp || m.sealedStamp.length > MAX_SEALED_STAMP || !STAMP_CHARS.test(m.sealedStamp))
      )
        return void (await fail('bad_message'));
      const sealedStamp = momo && m.sealedStamp ? m.sealedStamp : '';
      const target = await pushTarget(hub, conn.identity, m.pair);
      if (!target) return void (await fail('unknown_pair', { pair: m.pair }));
      const { pairId, phoneDeviceId } = target;
      if (!target.token) return void (await hub.send(conn, { t: 'push.result', pair: pairId, status: 'no_token', rid }));
      // the provider may be slow: the answer follows when it is known, and the Mac's other messages are not held up behind it
      hub.track(
        conn,
        hub.push.request({ pairId, phoneDeviceId }, m.kind, m.ref, m.sealed, m.card, kind === 'host', m.sealedBody, sealedStamp).then(
          (status) => hub.send(conn, { t: 'push.result', pair: pairId, status, rid }),
          // the Mac waits for an answer to its request id: a push that broke is answered too, and logged by the caller of track
          (e) => fail('push_failed', { pair: pairId }).then(() => Promise.reject(e)),
        ),
      );
      return;
    }
    default:
      return hostControl(hub, conn, m, rid, fail);
  }
}
