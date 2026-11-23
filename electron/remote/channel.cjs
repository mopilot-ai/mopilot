// The Mac end of the sealed channel, as the remote service consumes it (shared/remote/transport.mjs RemoteTransport): send(pairId, msg), onMessage(fn), pairs(), onPairsChanged(fn), presence(pairId). Between the device list and the relay client it seals each message with its pair's ratchet (strictly increasing counters, the header authenticated), opens the phone's frames, hands over plain protocol messages, and answers a retried request with the reply it already gave (the last 1,000 request ids per pair). The service never sees keys, counters or the relay. A frame that does not open (a repeated or rewound counter, a gap too large, a failed tag, a malformed frame, one for no pair) is dropped and counted, never answered, and never ends the session: only a gap is told to the phone (once a minute). A local failure (a full receive queue, a failed save) pauses the session instead: what arrives is held unacknowledged, the receive counters go back to what was saved, and the relay is asked (with a wait that doubles) to send again what it has not seen acknowledged; a new relay connection reopens it. Only a pair that was removed ends for good. Frames of counter 0 are pairing hellos and go to the pairing service.
//
// Persistence: the send ratchet is saved 64 counters ahead of the one in use, so a crash resumes past every counter ever sent (the phone skips the gap); the receive ratchet is saved before dispatch, serially per pair. A crash after saving but before dispatch can leave the outcome unknown; it does not promise exactly-once execution. When the relay keeps frames until they are acknowledged (relay.acks), a frame is acked once its receive ratchet is saved (or once it can never be accepted), never before; a frame that comes again after a lost ack or a crash is already behind the ratchet, so it is acked and dropped without closing the session.
const {
  createCrypto,
  decodeFrame,
  toWire,
  encodeMessage,
  checkMessage,
  decodeMessage,
  fromHex,
  toHex,
  EnvelopeError,
  MAX_FRAME_BYTES,
} = require('./esm.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { ReceiptAcker } = require('../../shared/remote/ack.mjs');
const { skipsSeal, refusedFrame, phoneHeard } = require('./awayEvents.cjs');
const { catchUpFrom, forgetWalked } = require('./catchUp.cjs');
const { SessionPauses, PAUSES, RESYNC_EVENT, newCounts, ended } = require('./sessionPause.cjs');

const SEEN_PER_PAIR = 1000;
/** The replies kept for retries are bounded by size too: a thousand large replies would hold hundreds of megabytes. */
const SEEN_MAX_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_AHEAD = 64;
/** What sealing adds to a message (the AEAD tag); a message must leave room for it inside the 256 KB frame. */
const SEAL_OVERHEAD = 16;
const RECEIVE_MAX_FRAMES = 256;
const RECEIVE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {{ device: import('./deviceList.cjs').Device, tx: ReturnType<ReturnType<typeof createCrypto>['createSender']>, rx: ReturnType<ReturnType<typeof createCrypto>['createReceiver']>,
 *   savedTx: number, holes?: number, sealed: { ctr: number, before: { ctr: number, chain: Uint8Array } } | null, closed: string | null, noticedAt?: number, missedAt?: number, walker?: any, counts: Record<string, number>, budget: number, budgetAt: number, sending: Promise<unknown>, seen: Map<string, object | null>, seenBytes: number, receiving: Promise<void>, receivingActive: boolean, receiveBytes: number, receiveCount: number, receiveQueue: { frame: any, bytes: number, lease: any, at: number }[] }} Session
 */

class RemoteChannel {
  /**
   * @param {object} o
   * @param {InstanceType<typeof import('./deviceList.cjs').DeviceList>} o.devices
   * @param {any} o.relay a RelayClient (sendFrame, on, state, presence)
   * @param {import('../../shared/remote/crypto.mjs').Primitives} o.prim
   * @param {(frame: { pair: string, dir: string, ctr: number, nonce: Uint8Array, box: Uint8Array }) => unknown} [o.onHello] a frame of counter 0: the pairing service
   * @param {() => number} [o.now]
   * @param {() => number} [o.mono] a clock that never goes back, for the per-phone work budget
   * @param {{ steps: number, perSecond: number }} [o.budget] the per-phone work budget for reading frames
   * @param {number} [o.reconnectMs] the first wait before a paused session asks the relay for its unacknowledged frames again
   * @param {InstanceType<typeof import('./sendLedger.cjs').SendLedger>} [o.sendLedger]
   * @param {(pairId: string) => boolean} [o.phoneAbsent] whether the relay says that pair's phone is not connected: its live-view events (awayEvents.cjs) are then not sealed, so the chain does not run ahead of a phone that cannot read it. Unknown is false.
   * @param {(pairId: string, receivedAt: number, sentAt: number) => void} [o.onPhoneFrame] a frame of that pair's own chain opened and was decoded (its tag verified, the counters saved; `receivedAt` is the mono time it arrived, `sentAt` the message's own time, which the phone sealed): the phone is connected. When that ends the phone's absence, at most one `live.missed` marker a minute is sealed to it, because the events skipped meanwhile are gone.
   * @param {number} [o.catchUpSkip] how far past its saved counter a phone may be caught up (default CATCH_UP_SKIP)
   */
  constructor(o) {
    this.o = o;
    /** The record of the messages phones sent, for the service to answer a send it already took; null keeps it in memory. */
    this.sendLedger = o.sendLedger ?? null;
    this.now = o.now ?? Date.now;
    this.crypto = createCrypto(o.prim);
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    /** @type {Set<(pairId: string, msg: any) => void>} */
    this.messageListeners = new Set();
    /** @type {Set<(pairs: string[]) => void>} */
    this.pairListeners = new Set();
    this.dropped = 0;
    this.duplicates = 0;
    this.pauser = new SessionPauses({
      sessions: () => this.sessions.values(),
      relay: o.relay,
      devices: o.devices,
      crypto: this.crypto,
      now: this.now,
      mono: o.mono,
      budget: o.budget,
      reconnectMs: o.reconnectMs,
      notify: (pairId, notice) => this.#send(pairId, notice, true),
    });
    this.acker = new ReceiptAcker({ send: (m) => this.o.relay.sendAck(m), enabled: () => this.o.relay.acks === true });
    /** @type {(() => void)[]} */
    this.unsubscribe = [];
    this.startEpoch = 0;
  }

  /** Loads the paired phones and starts listening to the relay and the list. Safe to call once; stop() undoes it. */
  async start() {
    const mine = ++this.startEpoch;
    await this.o.devices.load();
    if (mine !== this.startEpoch) return;
    this.#sync(this.o.devices.list());
    this.unsubscribe.push(
      this.o.devices.onChange((list) => this.#sync(list)),
      this.o.relay.on('frame', (/** @type {unknown} */ f) => this.#receive(f)),
      this.o.relay.on('event', (/** @type {any} */ e) => this.#relayEvent(e)),
      this.o.relay.on('error', (/** @type {any} */ e) => this.#frameRefused(e)),
      // a new relay connection brings the unacknowledged frames again, so paused sessions are ready for them
      // a fresh socket delivers its backlog from its first frame (right after the hello), so paused sessions are open as soon as one is being made
      this.o.relay.on('open', () => this.pauser.reopenAll()),
      this.o.relay.on('state', (/** @type {string} */ state) => state === 'connecting' && this.pauser.reopenAll()),
    );
  }

  stop() {
    this.startEpoch++;
    for (const off of this.unsubscribe.splice(0)) off();
    this.pauser.shutdown();
    for (const s of this.sessions.values()) this.#clearReceiveQueue(s);
    this.sessions.clear();
  }

  // ---- RemoteTransport ----

  /** @param {string} pairId @param {object} msg @returns {Promise<void>} */
  send(pairId, msg) {
    return this.#send(pairId, msg, false);
  }

  #send(/** @type {string} */ pairId, /** @type {object} */ msg, /** @type {boolean} */ notice) {
    const s = this.sessions.get(pairId);
    if (!s) return Promise.reject(new Error(`Unknown pair ${pairId}`));
    if (ended(s) && !notice) return Promise.reject(new Error('The pair session is closed'));
    const lease = this.o.devices.lease(s.device.id, pairId);
    if (!lease) return Promise.reject(new Error('The pair is being changed'));
    // a sender that builds a message the receiver would refuse learns it here, not as a dropped message on the phone
    try {
      checkMessage(msg);
    } catch (error) {
      return Promise.reject(error);
    }
    const plain = encodeMessage(msg);
    // refused before it takes a counter or is remembered as a reply: the phone's ratchet and a retry see nothing of it
    if (plain.length + SEAL_OVERHEAD > MAX_FRAME_BYTES) return Promise.reject(new EnvelopeError('size', 'frame over 256 KB'));
    // one at a time per pair, so counters, checkpoints and the relay see the same order
    const run = s.sending.then(() => this.#seal(s, plain, /** @type {any} */ (msg), lease, notice));
    s.sending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @param {(pairId: string, msg: any) => void} fn @returns {() => void} */
  onMessage(fn) {
    this.messageListeners.add(fn);
    return () => void this.messageListeners.delete(fn);
  }

  pairs() {
    return [...this.sessions.keys()];
  }

  /** @param {(pairs: string[]) => void} fn @returns {() => void} */
  onPairsChanged(fn) {
    this.pairListeners.add(fn);
    return () => void this.pairListeners.delete(fn);
  }

  /** A phone is reachable while the relay is: its mailbox holds what it misses. A Mac that told the relay it sleeps says so. @param {string} pairId @returns {'online' | 'sleeping' | 'gone'} */
  presence(pairId) {
    if (!this.sessions.has(pairId) || this.o.relay.state !== 'open') return 'gone';
    return this.o.relay.presence === 'sleeping' ? 'sleeping' : 'online';
  }

  /** A pair's session was closed for good (`retired`) or paused (`overload`, `storage`: it comes back, see onPairReopened). @param {(e: { pairId: string, code: string }) => void} fn */
  onPairClosed(fn) {
    this.pauser.closed.add(fn);
    return () => void this.pauser.closed.delete(fn);
  }

  /** Why a pair's session is paused or closed, or null when it is open (or unknown). @param {string} pairId */
  closedReason(pairId) {
    return this.sessions.get(pairId)?.closed ?? null;
  }

  /** A paused session is open again. @param {(e: { pairId: string, code: string }) => void} fn */
  onPairReopened(fn) {
    this.pauser.reopened.add(fn);
    return () => void this.pauser.reopened.delete(fn);
  }

  /** What the channel has seen, for diagnostics: frames dropped, repeated or ahead of their counter, pauses by reason, how many came back, relay reconnects asked for. */
  get stats() {
    return this.pauser.stats(this);
  }

  /** What this phone's frames did: dropped, repeated, ahead of the counter, held and throttled, and whether its session is paused. @param {string} pairId */
  statsOf(pairId) {
    const s = this.sessions.get(pairId);
    return s ? { ...s.counts, paused: !!s.closed && PAUSES.has(s.closed) } : null;
  }

  /** Frames dropped as malformed, forged or for no pair, for diagnostics. */
  get droppedFrames() {
    return this.dropped;
  }

  // ---- sessions ----

  /** Builds sessions for new pairs, drops those whose phone is gone, and tells the pair listeners when the set changed. @param {import('./deviceList.cjs').Device[]} list */
  #sync(list) {
    list = list.filter((d) => !this.o.devices.isRetired(d.pairId));
    const before = this.pairs().join();
    const live = new Set(list.map((d) => d.pairId));
    for (const [id, session] of this.sessions) {
      if (!live.has(id)) {
        this.#clearReceiveQueue(session);
        this.sessions.delete(id);
      }
    }
    for (const d of list) {
      if (this.sessions.has(d.pairId)) continue;
      this.sessions.set(d.pairId, {
        device: d,
        tx: this.crypto.createSender({ pair: d.pairId, dir: 'm2p', chain: fromHex(d.tx.chain), ctr: d.tx.ctr }),
        rx: this.crypto.createReceiver({ pair: d.pairId, dir: 'p2m', chain: fromHex(d.rx.chain), ctr: d.rx.ctr }),
        savedTx: d.tx.ctr,
        sealed: null,
        closed: null,
        sending: Promise.resolve(),
        seen: new Map(),
        seenBytes: 0,
        receiving: Promise.resolve(),
        receivingActive: false,
        receiveBytes: 0,
        receiveCount: 0,
        receiveQueue: [],
        counts: newCounts(),
        ...this.pauser.freshBudget(),
      });
    }
    if (this.pairs().join() === before) return;
    const now = this.pairs();
    for (const fn of [...this.pairListeners]) {
      try {
        fn(now);
      } catch (error) {
        noteIgnored('tell a pairs listener', error);
      }
    }
  }

  /** The relay says a pair is gone (the phone unpaired from its side, or its device was revoked): the Mac drops the pair key. */
  #relayEvent(/** @type {any} */ e) {
    if (e?.ev !== 'pair.removed') return;
    const s = typeof e.pair === 'string' ? this.sessions.get(e.pair) : undefined;
    if (s) {
      this.o.devices.retirePair(e.pair);
      this.#sync(this.o.devices.list());
      this.o.devices.removePair(s.device.id, e.pair).catch((error) => noteIgnored('forget a phone the relay removed', error));
    }
  }

  // ---- sending ----

  async #seal(
    /** @type {Session} */ s,
    /** @type {Uint8Array} */ plain,
    /** @type {any} */ msg,
    /** @type {any} */ lease,
    /** @type {boolean} */ notice,
  ) {
    if (ended(s) && !notice) throw new Error('The pair session is closed');
    if (!this.o.devices.currentLease(lease)) throw new Error('The pair is being changed');
    // a phone that is away reads the chat again when it returns: nothing is sealed for it, so its counter stays where it is
    if (!notice && skipsSeal(this.o, s, msg)) return;
    // the counter about to be used must be inside what is saved
    if (s.tx.state().ctr + 1 > s.savedTx) {
      const ahead = s.tx.peek(CHECKPOINT_AHEAD);
      await this.o.devices.update(s.device.id, { tx: { ctr: ahead.ctr, chain: toHex(ahead.chain) } }, s.device.pairId);
      s.savedTx = ahead.ctr;
    }
    if (this.sessions.get(s.device.pairId) !== s || !this.o.devices.currentLease(lease)) throw new Error(`Unknown pair ${s.device.pairId}`);
    if (ended(s) && !notice) throw new Error('The pair session is closed');
    const before = s.tx.state();
    const frame = s.tx.seal(plain);
    // a reply is remembered, so the phone retrying its request gets this answer again
    if (msg?.kind === 'reply' && typeof msg.inReplyTo === 'string' && s.seen.has(msg.inReplyTo)) this.#remember(s, msg.inReplyTo, msg);
    s.sealed = { ctr: frame.ctr, before };
    const outcome = this.o.relay.sendFrame(toWire(frame));
    if (outcome === 'dropped') {
      // the counter was never used by anything the phone can receive: take it back, or enough refusals in a row would put the phone more than
      // MAX_SKIP counters behind and leave its session unable to read the next frame
      this.#takeBack(s, before);
      throw new Error('The relay is not accepting messages');
    }
  }

  #takeBack(/** @type {Session} */ s, /** @type {{ ctr: number, chain: Uint8Array }} */ before) {
    s.tx = this.crypto.createSender({ pair: s.device.pairId, dir: 'm2p', chain: before.chain, ctr: before.ctr });
    s.sealed = null;
  }

  #frameRefused(/** @type {any} */ e) {
    const s = e?.code === 'mailbox_full' && typeof e.pair === 'string' ? this.sessions.get(e.pair) : undefined;
    if (s) refusedFrame(s, e.ctr, (before) => this.#takeBack(s, before));
  }

  // ---- receiving ----

  #receive(/** @type {unknown} */ wire) {
    let frame;
    try {
      frame = decodeFrame(/** @type {any} */ (wire));
    } catch {
      // decodeFrame only throws EnvelopeError: a frame that is not one
      this.dropped++;
      return;
    }
    if (frame.ctr === 0) {
      Promise.resolve()
        .then(() => this.o.onHello?.(frame))
        .catch((error) => noteIgnored('handle a pairing hello', error));
      return;
    }
    const s = this.sessions.get(frame.pair);
    if (s && s.closed && PAUSES.has(s.closed)) {
      // not read, not acknowledged: the relay sends it again once the session is back
      this.pauser.count(s, 'held');
      return;
    }
    if (!s || s.closed) {
      this.dropped++;
      if (s) s.counts.dropped++;
      // a pair that is not known yet may appear (a pairing still activating): leave it unacked so the relay redelivers
      if (s) this.acker.settle(frame, 'dropped');
      return;
    }
    const lease = this.o.devices.lease(s.device.id, frame.pair);
    if (!lease) {
      this.#close(s, 'retired');
      this.acker.settle(frame, 'dropped');
      return;
    }
    const bytes = frame.nonce.byteLength + frame.box.byteLength;
    if (s.receiveCount >= RECEIVE_MAX_FRAMES || s.receiveBytes + bytes > RECEIVE_MAX_BYTES) {
      // this frame stays unacknowledged, and so does every later one (reading one would skip this one); the queued frames are still read, and
      // when they are done the relay is asked to send the rest again, in order
      this.pauser.count(s, 'held');
      this.#pause(s, 'overload');
      return;
    }
    s.receiveQueue.push({ frame, bytes, lease, at: this.pauser.mono() });
    s.receiveCount++;
    s.receiveBytes += bytes;
    if (!s.receivingActive) {
      s.receivingActive = true;
      s.receiving = this.#drainReceive(s);
    }
  }

  #clearReceiveQueue(/** @type {Session} */ s) {
    for (const item of s.receiveQueue) {
      s.receiveCount--;
      s.receiveBytes -= item.bytes;
    }
    s.receiveQueue.length = 0;
  }

  async #drainReceive(/** @type {Session} */ s) {
    while (s.receiveQueue.length) {
      const item = /** @type {{ frame: any, bytes: number, lease: any, at: number }} */ (s.receiveQueue.shift());
      await this.#openFrame(s, item.frame, item.lease, item.at);
      s.receiveCount--;
      s.receiveBytes -= item.bytes;
    }
    s.receivingActive = false;
    // the queue that filled up has been read: the frames refused meanwhile are asked for again
    this.pauser.drained(s);
  }

  async #openFrame(/** @type {Session} */ s, /** @type {any} */ frame, /** @type {any} */ lease, /** @type {number} */ at) {
    if (!this.o.devices.currentLease(lease)) {
      this.#close(s, 'retired');
      this.acker.settle(frame, 'dropped');
      return;
    }
    // the walk over skipped counters comes before the tag check: a frame this phone cannot pay for yet waits its turn, so none is read past
    if (!(await this.pauser.buy(s, frame.ctr - s.rx.state().ctr))) return;
    let plain;
    try {
      plain = s.rx.open(frame);
    } catch (error) {
      // a frame that does not open changes nothing, so it cannot end the session: whoever sent it could otherwise silence the pair
      const code = /** @type {any} */ (error)?.code;
      if (code === 'replay' || code === 'rewind') {
        // the relay redelivers what it never saw acked; the ratchet is already past this frame, which can no longer be opened
        this.duplicates++;
        s.counts.duplicates++;
        this.acker.settle(frame, 'duplicate');
        return;
      } else if (code === 'gap') {
        // the phone is far ahead of this Mac's counter (frames were lost): a walk within the cap, once in a while, may still open it
        const far = await catchUpFrom(this, s, frame);
        // the session paused meanwhile: the frame is not judged and stays unacknowledged, and so do the frames queued behind it (reading one would skip this one): the queue is let go as a failed save does, and the relay sends them all again, in order
        if (far === 'held') return void this.#clearReceiveQueue(s);
        if (!far) {
          // nothing opened and nothing changed: the phone is told, and says so to the person
          this.acker.settle(frame, 'dropped');
          this.pauser.noticeGap(s);
          return;
        }
        // the tag opened under the pair's own chain: the new receiver replaces the old one and the frame is saved like any other
        s.rx = far.rx;
        plain = far.plain;
      } else {
        this.dropped++;
        s.counts.dropped++;
        this.acker.settle(frame, 'dropped');
        return;
      }
    }
    const state = s.rx.state();
    try {
      const saved = await this.o.devices.update(
        s.device.id,
        { rx: { ctr: state.ctr, chain: toHex(state.chain) }, lastSeenAt: this.now() },
        s.device.pairId,
      );
      forgetWalked(s);
      // a frame already saved is handled even when the session paused meanwhile: it cannot come again
      if (!saved || this.sessions.get(frame.pair) !== s || ended(s)) return void this.acker.settle(frame, 'dropped');
      if (!this.o.devices.currentLease(lease)) {
        this.#close(s, 'retired');
        return void this.acker.settle(frame, 'dropped');
      }
      this.acker.settle(frame, 'accepted');
    } catch (error) {
      noteIgnored('save a receive counter', error);
      // not acknowledged: the relay sends it again; the counters go back to what was saved before any later frame is read
      if (this.sessions.get(frame.pair) === s && (!s.closed || s.closed === 'overload')) this.#pause(s, 'storage');
      return;
    }
    let msg;
    try {
      msg = decodeMessage(plain);
    } catch {
      // sealed by the phone but not a protocol message: nothing to hand over
      this.dropped++;
      return;
    }
    phoneHeard(this.o, s, at, msg, this.now(), (notice) => this.#send(s.device.pairId, notice, true));
    if (msg.kind === 'request') {
      if (s.seen.has(msg.id)) return void this.#again(s, msg);
      this.#remember(s, msg.id, null);
    }
    for (const fn of [...this.messageListeners]) {
      try {
        fn(frame.pair, msg);
      } catch (error) {
        noteIgnored('hand a remote message to the service', error);
      }
    }
  }

  /** The same request again: the answer already given goes out again; one still being worked on is left to finish. */
  #again(/** @type {Session} */ s, /** @type {any} */ msg) {
    const reply = s.seen.get(msg.id);
    if (!reply) return;
    this.send(s.device.pairId, reply).catch((error) => noteIgnored('send a reply again', error));
  }

  #remember(/** @type {Session} */ s, /** @type {string} */ id, /** @type {object | null} */ reply) {
    this.#forget(s, id);
    s.seen.set(id, reply);
    s.seenBytes += reply ? JSON.stringify(reply).length : 0;
    // the oldest go first, but never the one just added
    while (s.seen.size > 1 && (s.seen.size > SEEN_PER_PAIR || s.seenBytes > SEEN_MAX_BYTES))
      this.#forget(s, /** @type {string} */ (s.seen.keys().next().value));
  }

  #forget(/** @type {Session} */ s, /** @type {string} */ id) {
    const old = s.seen.get(id);
    if (old) s.seenBytes -= JSON.stringify(old).length;
    s.seen.delete(id);
  }

  /** A failed save puts the counters back, so what was queued after it is read again from the relay; a full queue keeps its frames, which come first. */
  #pause(/** @type {Session} */ s, /** @type {'overload' | 'storage'} */ code) {
    if (code === 'storage') this.#clearReceiveQueue(s);
    this.pauser.pause(s, code);
  }

  #close(/** @type {Session} */ s, /** @type {string} */ code) {
    s.closed = code;
    this.#clearReceiveQueue(s);
    const pairId = s.device.pairId;
    const notice = { id: `n_${this.now()}_${code}`, t: this.now(), kind: 'event', ev: RESYNC_EVENT, patch: { reason: code } };
    this.#send(pairId, notice, true).catch((error) => noteIgnored('ask a phone to resync', error));
    this.pauser.tell(this.pauser.closed, pairId, code);
  }
}

module.exports = { RemoteChannel, SEEN_PER_PAIR, SEEN_MAX_BYTES, CHECKPOINT_AHEAD, RESYNC_EVENT, RECEIVE_MAX_FRAMES, RECEIVE_MAX_BYTES };
