// The relay's core: who is connected, which pair each frame belongs to, delivery live or through the mailbox, presence,
// push requests and revocation. It is socket-agnostic (server.mjs adapts `ws`), so tests drive it with fake sockets and
// a fake clock. The relay forwards `box` bytes untouched; it checks only who may send on which pair and in which direction.
import { messageOf } from './processGuards.mjs';
import { Conn, admit, isReceipt, release, sendText } from './connection.mjs';
import { DurableMailbox, countMailboxFull } from './durableMailbox.mjs';
import { handleFrame } from './frameRetry.mjs';
import { receipt } from './receipts.mjs';
import { control } from './control.mjs';
import { encode, encodeFrame, parseFrame, parseMessage } from './frames.mjs';
import { limitsOf } from './limits.mjs';
import { Metrics } from './metrics.mjs';
import { PairCache } from './pairCache.mjs';
import { deliverDrops, deliverDurableDrops } from './drops.mjs';
import { closeHub, refusalFor, shutdownHub, sweepHub, tickHub } from './liveness.mjs';
import { Buckets } from './rateLimit.mjs';
import { HostStore } from './hostStore.mjs';
import { bootData, hostGone, isHostKind, liveFrame, peerChanged, refreshed, revocableId } from './hosts.mjs';
import { revokeDevice } from './revoke.mjs';
import { createBoots } from './boot.mjs';
import { createRendezvous } from './rendezvous.mjs';
import { closeOf, countRefusal, refusedDisabled } from './access.mjs';

/** @typedef {import('./connection.mjs').Socket} Socket */
/** @typedef {import('./connection.mjs').Identity} Identity */

const FRAMES_HELP = 'Frames the relay took from senders: via live (sent straight to the peer) or mailbox (stored first)';
const MISSED_PINGS = 3;
const TOKEN_GRACE_MS = 60_000;
const BATCH = 50;
/** Close codes a Mac sends on purpose; anything else means it vanished. */
const CLEAN = new Set([1000, 1001, 1005]);
/** How long a cached pair row or device pair list is trusted. Every change this process makes drops the entry; the clock only bounds a change made behind its back. */
const CACHE_MS = 60_000;

export class Hub {
  /**
   * @param {object} o
   * @param {import('./store.mjs').Store} o.store
   * @param {import('./push.mjs').PushService} o.push
   * @param {{ verify(token: string): Promise<Identity | null> }} o.verifier
   * @param {{ mailbox: { ttlMs: number, maxFrames: number, maxBytes: number }, pairJoinMs: number, limits?: Partial<import('./limits.mjs').Limits>, trustProxy?: boolean, bootOrigin?: string | null, rendezvous?: boolean }} o.config
   * @param {() => number} [o.now]
   * @param {(event: string, data: object) => void} [o.log] ids and sizes only, never a frame
   * @param {import('./durableStore.mjs').DurableStore} [o.durable] keeps a frame until its receiver acknowledges it (counter 0, the pairing hello, still uses the plain mailbox)
   * @param {(ms: number) => Promise<void>} [o.sleep] how a rate-limited frame waits (a test passes its own)
   * @param {Metrics} [o.metrics] where events are counted
   */
  constructor({
    store,
    push,
    verifier,
    config,
    now = Date.now,
    log = () => undefined,
    durable,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    metrics = new Metrics(),
  }) {
    this.store = store;
    this.push = push;
    this.verifier = verifier;
    this.config = config;
    this.now = now;
    this.log = log;
    this.limits = limitsOf(config);
    this.sleep = sleep;
    this.metrics = metrics;
    /** @type {Buckets} frames per pair, both directions together; a bucket exists only for a pair a connection has been shown to belong to */
    this.pairBuckets = new Buckets(this.limits.pairFrameRate, this.limits.pairFrameBurst, now);
    // by device, not by connection: a client that reconnects to start over with full buckets gets nothing by it
    this.frameBuckets = new Buckets(this.limits.frameRate, this.limits.frameBurst, now);
    this.receiptBuckets = new Buckets(this.limits.receiptRate, this.limits.receiptBurst, now);
    this.controlBuckets = new Buckets(this.limits.controlRate, this.limits.controlBurst, now);
    this.connectBuckets = new Buckets(this.limits.connectRate, this.limits.connectBurst, now);
    /** failed Host credentials per remote address (hosts.mjs verifyHost) */
    this.hostAuthBuckets = new Buckets(this.limits.hostAuthRate, this.limits.hostAuthBurst, now);
    this.hostAddressBuckets = new Buckets(this.limits.hostAddressRate, this.limits.hostAddressBurst, now);
    this.hosts = new HostStore(store.db);
    /** Add by command's boot ids and the downloads they proxy (boot.mjs): memory only */
    this.boots = createBoots({ now, origin: config.bootOrigin ?? null, perDay: this.limits.bootsPerDay, log });
    /** Pairing two computers by a code (rendezvous.mjs): memory only, five minutes at most; null (and its routes unknown) unless RENDEZVOUS=1 */
    this.rendezvous = config.rendezvous ? createRendezvous({ now, metrics }) : null;
    /** set once a shutdown starts: new sockets are refused and closing sockets raise no offline notices */
    this.draining = false;
    this.cache = new PairCache(now, CACHE_MS);
    /** @type {Set<string>} `<pair>:<dir>` that may hold plain-mailbox rows a connected receiver has not been sent */
    this.plainWaiting = new Set();
    this.mailbox = /** @type {any} */ (durable ? new DurableMailbox({ durable, config, now, log }) : null);
    /** @type {Map<string, Conn>} */
    this.conns = new Map();
    /** @type {Set<Conn>} every connection from the moment it is adopted until its socket has closed, including ones still starting */
    this.all = new Set();
    /** @type {Map<string, { state: 'online' | 'sleeping', at: number }>} what each Mac last said; absent means gone */
    this.presence = new Map();
  }

  /**
   * Adopts an authenticated socket. Returns the handlers the transport calls; messages run one at a time in arrival order.
   * @param {Socket} socket
   * @param {Identity} identity
   */
  connect(socket, identity) {
    const conn = new Conn(socket, identity);
    this.all.add(conn);
    const maxReceipts = Math.max(this.limits.pendingMax, this.config.mailbox.maxFrames);
    const run = (/** @type {() => Promise<void>} */ fn, receipt = false, bytes = 0) => {
      conn.queue = conn.queue
        .then(fn)
        .catch((e) => this.log('error', { device: identity.deviceId, message: messageOf(e) }))
        .finally(() => release(conn, receipt, bytes, this.limits));
    };
    // the start-up counts as one waiting message, so the connection's first real message never overlaps it
    admit(conn, false, 0, this.limits, maxReceipts, true);
    run(() => this.start(conn));
    return {
      message: (/** @type {string} */ raw) => {
        // a shutdown has begun: what arrives now is not started, and its sender resends it after reconnecting
        if (this.draining) return;
        // any message shows the client is alive: a busy one may answer a ping late
        conn.missed = 0;
        const receipt = isReceipt(raw);
        if (!admit(conn, receipt, raw.length, this.limits, maxReceipts)) return this.drop(conn, 1008, 'too many pending messages');
        run(() => this.handle(conn, raw), receipt, raw.length);
      },
      pong: () => {
        conn.missed = 0;
      },
      close: (/** @type {number} */ code) => {
        conn.gone = true;
        admit(conn, false, 0, this.limits, maxReceipts, true);
        run(() => this.closed(conn, code));
      },
    };
  }

  async start(/** @type {Conn} */ conn) {
    const { deviceId, kind } = conn.identity;
    if (this.draining) return this.drop(conn, 1012, 'restarting');
    if (await this.store.isRevoked(revocableId(conn.identity))) return this.drop(conn, 4403, 'revoked');
    // a device that connects over and over is told to wait: each connect costs the relay a presence broadcast and a full delivery
    if (this.connectBuckets.get(deviceId).tryTake() > 0) return this.drop(conn, 1013, 'reconnecting too fast');
    const old = this.conns.get(deviceId);
    if (old) {
      this.conns.delete(deviceId);
      this.drop(old, 4000, 'replaced');
    }
    if (this.draining) return this.drop(conn, 1012, 'restarting');
    const refused = this.refusal(conn.identity, conn);
    if (refused) {
      countRefusal(this, refused);
      return this.drop(conn, ...closeOf(refused));
    }
    this.conns.set(deviceId, conn);
    // a revocation that landed while this connection was starting found nothing to close
    if ((await this.store.isRevoked(revocableId(conn.identity))) || (await hostGone(this, conn.identity))) {
      this.conns.delete(deviceId);
      return this.drop(conn, 4403, 'revoked');
    }
    // the same for an account switched off meanwhile (the upgrade asked before this socket existed)
    if (await refusedDisabled(this, conn)) return;
    if (kind === 'desktop') this.presence.set(deviceId, { state: 'online', at: this.now() });
    this.cache.drop('-', [deviceId]);
    const pairs = await this.pairsOf(deviceId);
    await this.send(conn, {
      t: 'hello',
      device: deviceId,
      kind,
      pairs: pairs.map((p) => this.describe(p, deviceId)),
      ...(this.mailbox ? { acks: true } : {}),
      ...(kind === 'desktop' ? { peerEvents: true } : {}),
    });
    if (kind === 'desktop') await this.broadcastPresence(deviceId);
    if (isHostKind(kind) || kind === 'phone') await peerChanged(this, conn, pairs, true);
    for (const p of pairs) await this.deliverDrops(conn, p.pairId, p.macDeviceId === deviceId ? 'm2p' : 'p2m');
    // a returning device is sent everything waiting for it, the plain mailbox included, before it is trusted to be caught up
    await this.kick(conn, true);
    this.log('connect', { device: deviceId, kind });
  }

  /** Whether a device may connect now: null, or why not (see refusalFor). @param {Identity} identity @param {Conn | null} [self] */
  refusal(identity, self = null) {
    return refusalFor(this, identity, self);
  }

  describe(/** @type {{ pairId: string, macDeviceId: string, phoneDeviceId: string | null }} */ p, /** @type {string} */ deviceId) {
    const role = p.macDeviceId === deviceId ? 'mac' : 'phone';
    return {
      pair: p.pairId,
      role,
      joined: p.phoneDeviceId !== null,
      peerOnline: this.conns.has((role === 'mac' ? p.phoneDeviceId : p.macDeviceId) ?? ''),
      presence: role === 'phone' ? this.presenceOf(p.macDeviceId) : undefined,
    };
  }

  presenceOf(/** @type {string} */ macDeviceId) {
    return this.presence.get(macDeviceId)?.state ?? 'gone';
  }

  /** @returns {Promise<boolean>} whether the socket took the text */
  send(/** @type {Conn} */ conn, /** @type {object | string} */ m) {
    return sendText(conn, typeof m === 'string' ? m : encode(m), this.limits, (slow) => this.dropSlow(slow));
  }

  drop(/** @type {Conn} */ conn, /** @type {number} */ code, /** @type {string} */ reason) {
    conn.closed = true;
    // a paused socket reads nothing, not even the other side's answer to this close
    if (conn.paused) {
      conn.paused = false;
      conn.socket.resume?.();
    }
    try {
      conn.socket.close(code, reason);
    } catch {
      conn.socket.terminate();
    }
  }

  /** A receiver that does not read: it is told why and cut at once (its close handshake would wait behind the bytes it has not read); what was stored for it stays stored. */
  dropSlow(/** @type {Conn} */ conn) {
    if (conn.closed) return;
    this.drop(conn, 1013, 'slow consumer');
    conn.socket.terminate();
    this.metrics.inc('relay_slow_consumers_total', {}, 1, 'Receivers dropped for not reading');
    this.log('slow_consumer', { device: conn.identity.deviceId });
  }

  /** A pair's row, from the cache while no change has touched it. */
  pairRow(/** @type {string} */ pairId) {
    return this.cache.get(`pair:${pairId}`, () => this.store.getPair(pairId), false);
  }

  /** The pairs a device is on, from the cache while no change has touched them. */
  pairsOf(/** @type {string} */ deviceId) {
    return this.cache.get(`device:${deviceId}`, () => this.store.pairsForDevice(deviceId));
  }

  async handle(/** @type {Conn} */ conn, /** @type {string} */ raw) {
    if (conn.closed) return;
    const m = parseMessage(raw);
    const rid = typeof m?.rid === 'string' ? m.rid.slice(0, 64) : undefined;
    const fail = (/** @type {string} */ code, extra = {}) => {
      this.metrics.inc('relay_errors_total', { code }, 1, 'Errors sent to clients, by code');
      return this.send(conn, { t: 'error', code, rid, ...extra });
    };
    if (!m) return void (await fail('bad_message'));
    const { deviceId } = conn.identity;
    switch (m.t) {
      case 'auth': {
        const wait = this.controlBuckets.get(deviceId).tryTake();
        if (wait > 0) return void (await fail('rate_limited', { retryAfterMs: wait }));
        const next = refreshed(conn.identity, typeof m.token === 'string' ? await this.verifier.verify(m.token) : null);
        if (!next) return this.drop(conn, 4401, 'auth');
        conn.identity = next;
        return void (await this.send(conn, { t: 'ok', op: 'auth', rid }));
      }
      case 'frame':
        return handleFrame(this, conn, m, fail);
      case 'ack':
        return receipt(this, conn, m, fail);
      // a boot download's bytes, paced like frames (a bundle is many of them), not refused like a control message
      case 'boot.data':
        return bootData(this, conn, m);
      default: {
        // pairing, presence and push are rare; a connection sending them in a flood is told to wait, and the message is not handled
        const wait = this.controlBuckets.get(deviceId).tryTake();
        if (wait > 0) return void (await fail('rate_limited', { retryAfterMs: wait }));
        return control(this, conn, m, rid, fail);
      }
    }
  }

  async frame(
    /** @type {Conn} */ conn,
    /** @type {any} */ m,
    /** @type {(code: string, extra?: object) => Promise<boolean>} */ fail,
    /** whether this is a new attempt at a frame that already paid for its place (rate limits) */ again = false,
  ) {
    const { deviceId } = conn.identity;
    // every frame costs a token, one that turns out to be invalid too: they are answered, not free
    if (!again && !(await this.pace(conn, this.frameBuckets.get(deviceId).take()))) return;
    const f = parseFrame(m);
    if (!f) return void (await fail('bad_frame', { pair: m.pair }));
    const pair = await this.pairRow(f.pairId);
    const role = pair?.macDeviceId === deviceId ? 'mac' : pair?.phoneDeviceId === deviceId ? 'phone' : null;
    if (!pair?.phoneDeviceId || !role) return void (await fail('unknown_pair', { pair: f.pairId }));
    if (f.dir !== (role === 'mac' ? 'm2p' : 'p2m')) return void (await fail('bad_dir', { pair: f.pairId }));
    const peerId = role === 'mac' ? pair.phoneDeviceId : pair.macDeviceId;
    if (!again && !(await this.pace(conn, this.pairBuckets.get(f.pairId).take()))) return;
    if (isHostKind(conn.identity.kind)) return liveFrame(this, conn, f, peerId, fail);
    const ack = { t: 'ack', pair: f.pairId, dir: f.dir, ctr: f.ctr };
    if (this.mailbox && f.ctr > 0) return this.durableFrame(conn, pair, f, peerId, ack, fail);
    const peer = this.conns.get(peerId);
    // a peer mid-drain gets the frame through the mailbox, behind the older ones, so order holds
    if (peer && !peer.draining && (await this.send(peer, encodeFrame(f.pairId, f.dir, f.ctr, f.nonce, f.box)))) {
      this.metrics.inc('relay_frames_total', { dir: f.dir, via: 'live' }, 1, FRAMES_HELP);
      return void (await this.send(conn, { ...ack, via: 'live' }));
    }
    const { ttlMs, maxFrames, maxBytes } = this.config.mailbox;
    const stored = await this.store.enqueue({
      pairId: f.pairId,
      dir: f.dir,
      ctr: f.ctr,
      nonce: f.nonce,
      box: f.box,
      now: this.now(),
      ttlMs,
      maxFrames,
      maxBytes,
      // the plain mailbox (pairing frames, and every frame without the durable one) has the same account and relay-wide bounds
      account: { frames: this.limits.accountMaxFrames, bytes: this.limits.accountMaxBytes },
      relay: { frames: this.limits.globalMaxFrames, bytes: this.limits.globalMaxBytes },
    });
    // the plain mailbox's statement does not say which of its caps refused
    if (!stored) return void (countMailboxFull(this.metrics, 'plain'), await fail('mailbox_full', { pair: f.pairId, ctr: f.ctr }));
    this.plainWaiting.add(`${f.pairId}:${f.dir}`);
    this.metrics.inc('relay_frames_total', { dir: f.dir, via: 'mailbox' }, 1, FRAMES_HELP);
    await this.send(conn, { ...ack, via: 'mailbox' });
    const live = this.conns.get(peerId);
    if (live) this.track(live, this.kick(live));
  }

  /** A counted frame is stored first, whether or not its peer is connected, and the sender hears so; the peer is then sent it and must acknowledge it. */
  async durableFrame(
    conn,
    /** @type {any} */ pair,
    /** @type {any} */ f,
    /** @type {string} */ peerId,
    /** @type {object} */ ack,
    /** @type {(code: string, extra?: object) => Promise<boolean>} */ fail,
  ) {
    const r = await this.mailbox.put(pair, conn.identity.deviceId, f);
    if (r.code === 'full')
      return void (countMailboxFull(this.metrics, r.scope), await fail('mailbox_full', { pair: f.pairId, ctr: f.ctr, scope: r.scope }));
    if (r.code === 'conflict') return void (await fail('ctr_conflict', { pair: f.pairId, ctr: f.ctr }));
    if (r.code === 'expired') return void (await this.send(conn, { ...ack, via: 'consumed' }));
    if (r.code !== 'stored' && r.code !== 'duplicate') return void (await fail('unknown_pair', { pair: f.pairId }));
    if (r.code === 'stored') this.metrics.inc('relay_frames_total', { dir: f.dir, via: 'mailbox' }, 1, FRAMES_HELP);
    await this.send(conn, { ...ack, via: 'mailbox' });
    const live = this.conns.get(peerId);
    if (live) this.track(live, this.kick(live));
  }

  /**
   * Holds a message until its token is there: a flood is slowed to its limit (the socket is paused meanwhile, so TCP holds the
   * sender back), not refused. A debt longer than the longest wait is a flood that does not stop: the connection is closed. A
   * socket already gone is not slowed (its backlog is handled and its close follows). Returns false when the message is not to be handled.
   * @param {Conn} conn @param {number} wait milliseconds
   */
  async pace(conn, wait) {
    if (wait > this.limits.maxWaitMs) {
      this.drop(conn, 1008, 'rate limited');
      return false;
    }
    if (wait <= 0) return true;
    if (!conn.gone) await this.sleep(wait);
    // a connection dropped or a relay stopped while the message waited: it was never stored or answered, so its sender resends it
    return !conn.closed && !this.draining;
  }

  /**
   * Lets work run for a connection without its queue waiting for it (a delivery to a receiver whose socket is slow, a push to a
   * provider that is): the sender of a frame is answered, and its next message handled, meanwhile. A shutdown waits for it.
   */
  track(/** @type {Conn} */ conn, /** @type {Promise<unknown>} */ work) {
    const done = work.then(
      () => undefined,
      (e) => this.log('error', { device: conn.identity.deviceId, message: messageOf(e) }),
    );
    conn.kicks.add(done);
    void done.finally(() => conn.kicks.delete(done));
  }

  /**
   * Sends a connection every frame waiting for it, oldest first. The plain mailbox is read for the pairs that have stored
   * something since the last read; `full` reads it for every pair (a connection that has just started).
   */
  async kick(/** @type {Conn} */ conn, full = false) {
    if (conn.closed) return;
    if (conn.draining) {
      // the delivery already under way goes round again, and reads the plain mailbox in full if this call asked for it
      conn.dirty = true;
      conn.fullPending ||= full;
      return;
    }
    conn.draining = true;
    try {
      do {
        conn.dirty = false;
        const everything = full || conn.fullPending;
        conn.fullPending = false;
        for (const p of await this.pairsOf(conn.identity.deviceId)) {
          if (!p.phoneDeviceId) continue;
          const dir = p.macDeviceId === conn.identity.deviceId ? 'p2m' : 'm2p';
          if (this.mailbox) await this.drainDurable(conn, p, dir);
          const waiting = `${p.pairId}:${dir}`;
          if (!everything && !this.plainWaiting.has(waiting)) continue;
          // the mark is cleared before the read: a frame stored while the read is under way sets it again, and this pass (or the next) sees it
          this.plainWaiting.delete(waiting);
          // the plain mailbox: deleted once the socket took it
          for (;;) {
            let rows;
            try {
              rows = await this.store.waiting(p.pairId, dir, BATCH);
            } catch (e) {
              this.plainWaiting.add(waiting);
              throw e;
            }
            const sent = [];
            for (const r of rows) {
              if (!(await this.send(conn, encodeFrame(p.pairId, dir, r.ctr, r.nonce, r.box)))) break;
              sent.push(r.id);
            }
            if (sent.length) await this.store.deleteFrames(sent);
            if (sent.length < rows.length) {
              // the socket stopped taking frames: the rest wait for the next delivery
              this.plainWaiting.add(waiting);
              break;
            }
            if (!rows.length) break;
          }
        }
      } while (conn.dirty && !conn.closed);
    } finally {
      conn.draining = false;
    }
  }

  /** Sends what the connection has not been sent yet and leaves it stored: only the receiver's ack removes a frame. */
  async drainDurable(/** @type {Conn} */ conn, /** @type {any} */ pair, /** @type {string} */ dir) {
    const key = `${pair.pairId}:${dir}`;
    for (;;) {
      const rows = await this.mailbox.pending(pair, conn.identity.deviceId, dir, conn.sent.get(key) ?? 0, BATCH);
      for (const r of rows) {
        if (!(await this.send(conn, encodeFrame(pair.pairId, dir, r.ctr, r.nonce, r.box)))) return;
        conn.sent.set(key, r.ctr);
      }
      if (rows.length < BATCH) return;
    }
  }

  /** The notices of frames dropped for a sender who was away (plain mailbox and durable). */
  deliverDrops(/** @type {Conn} */ conn, /** @type {string} */ pairId, /** @type {string} */ dir) {
    return deliverDrops(this, conn, pairId, dir);
  }

  deliverDurableDrops(/** @type {Conn} */ conn, /** @type {string} */ pairId, /** @type {string} */ dir) {
    return deliverDurableDrops(this, conn, pairId, dir);
  }

  async broadcastPresence(/** @type {string} */ macDeviceId) {
    const at = this.now();
    const state = this.presenceOf(macDeviceId);
    for (const p of await this.store.phonesOfMac(macDeviceId)) {
      const phone = this.conns.get(String(p.phoneDeviceId));
      if (phone) await this.send(phone, { t: 'event', ev: 'machine.presence', pair: p.pairId, state, at });
    }
  }

  /** A socket has closed: the device is gone from the hub, and a Mac that vanished is announced as gone. */
  closed(/** @type {Conn} */ conn, /** @type {number} */ code) {
    return closeHub(this, conn, code, CLEAN);
  }

  /** Every `pingMs`: ping each socket, end the ones that missed three, and end the ones whose token ran out without a refresh. */
  tick() {
    tickHub(this, MISSED_PINGS, TOKEN_GRACE_MS);
    // the pairing offers and limits that ran out go on the relay's own timer, never on a request
    this.rendezvous?.sweep();
  }

  /** Drops expired mailbox frames and tells the senders (now, or when they next connect). */
  sweep() {
    return sweepHub(this);
  }

  /**
   * Ends the service: no new sockets or messages, the message each connection is handling is finished and answered (its
   * frame is stored and its sender told before the socket goes), then every socket is closed with 1012 so the endpoints
   * reconnect at once. A connection that has not finished after `graceMs` is closed anyway; what it had not stored its sender resends.
   */
  shutdown({ graceMs = 8000 } = {}) {
    return shutdownHub(this, graceMs);
  }

  /** Push cleanup after a pair is gone; it runs last and a failure is logged, so it can never keep an unpair or a revoke from completing. */
  async pushCleanup(/** @type {string} */ pairId, /** @type {string | null} */ phoneDeviceId) {
    try {
      await this.push.pairRemoved(pairId, phoneDeviceId);
    } catch (e) {
      this.log('push_cleanup_failed', { pair: pairId, error: messageOf(e) });
    }
  }

  /** A device was revoked on mopilot.ai: forget what it held, close its socket and tell the peers of its pairs (revoke.mjs). Resolves how many pairs it removed. */
  revoke(/** @type {{ userId: string, deviceId: string }} */ who) {
    return revokeDevice(this, who);
  }
}
