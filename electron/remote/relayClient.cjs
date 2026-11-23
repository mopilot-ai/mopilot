// The Mac's one outbound WebSocket to the Mobile Remote relay per account (relay/src/hub.mjs is its other end); it never listens on a port. The socket is injectable (a WebSocket-shaped object with send, close and onopen/onmessage/onclose), so tests drive a fake relay. The account JWT goes in the upgrade request's Authorization header (never in the URL) and is renewed over the open socket every 10 minutes ({ t:'auth', token }). Wire, JSON text:
//   Mac → relay  { t:'frame', pair, dir, ctr, nonce, box } · { t:'pair.register'|'pair.remove', pair, rid } · { t:'presence', state:'online'|'sleeping', rid }
//   relay → Mac  { t:'hello', device, kind, pairs } on connect, after which the mailbox is delivered as { t:'frame', … } · { t:'ack', pair, dir, ctr, via } · { t:'ok', op, rid } ·
//                { t:'error', code, rid?, pair?, ctr? } · { t:'event', ev:'pair.joined'|'pair.removed'|'mailbox.dropped', … }
// Close codes: 4401 the token was refused (a fresh one is fetched for the next open), 4403 the device was revoked (no retry until start() is called again), and the relay's refusals (shared/remote/relayRefusal.mjs: 4503 it is at capacity, 4429 the account has its most devices connected, 4423 the account's relay access is switched off): the state is `refused`, `refusal` says which until a connection opens, and the next try waits 15 s doubling to 5 minutes instead of the usual backoff. The account service refusing the token for a switched-off account (`o.refused`) reads the same. Reconnect backoff is 1 s doubling to 10 s, jittered between half and all of it, reset by a good open (a short cap so a phone waiting for this Mac does not wait a minute after the network returns). The relay pings the socket itself; to notice a socket that went silent without closing, the Mac repeats its presence every 30 s as a heartbeat and drops a socket that left three unanswered. Frames sent while the socket is down wait in memory (the newest 200) and go out, in order, once it is open; every open publishes the last presence again. A relay that keeps frames until they are acknowledged says so in its hello ({ acks:true }); the channel then answers each frame it has durably accepted with { t:'ack', pair, dir, ctr } (shared/remote/ack.mjs), and the relay redelivers the rest after a reconnect.
const { noteIgnored } = require('../ignored.cjs');
const { encodeAck, relayAcks } = require('../../shared/remote/ack.mjs');
const { refusalOf, refusalWait } = require('../../shared/remote/relayRefusal.mjs');

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_UNANSWERED = 3;
const READY_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RENEW_MS = 10 * 60_000;
const MAX_QUEUED = 200;
const CLOSE_REVOKED = 4403;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_STALE = 4000;

/** @typedef {{ send(text: string): void, close(code?: number): void, onopen: null | (() => void), onmessage: null | ((e: { data: unknown }) => void), onclose: null | ((e: { code?: number }) => void), onerror: null | ((e: unknown) => void) }} RelaySocket */
/** @typedef {'idle' | 'connecting' | 'open' | 'backoff' | 'refused' | 'revoked' | 'stopped'} RelayState */
/** @typedef {import('../../shared/remote/relayRefusal.mjs').RelayRefusal} RelayRefusal */

class RelayClient {
  /**
   * @param {object} o
   * @param {() => string | null} o.url the relay's WebSocket URL (…/v1/ws); null when this build names none
   * @param {(force: boolean) => Promise<string | null>} o.getToken the relay's token (electron/identity/mopilot.cjs relayToken, audience `relay`); force asks for a fresh one
   * @param {() => RelayRefusal | null} [o.refused] why the account service gave no token, when it refused one (a switched-off account)
   * @param {(url: string, headers: Record<string, string>) => RelaySocket} [o.createSocket]
   * @param {() => number} [o.random]
   */
  constructor(o) {
    this.o = o;
    this.createSocket =
      o.createSocket ??
      ((/** @type {string} */ url, /** @type {Record<string, string>} */ headers) =>
        /** @type {any} */ (new WebSocket(url, /** @type {any} */ ({ headers }))));
    this.random = o.random ?? Math.random;
    /** @type {RelayState} */
    this.state = 'idle';
    this.epoch = 0;
    this.failures = 0;
    /** refusals in a row: what the wait after the next one grows from */
    this.refusals = 0;
    /** @type {RelayRefusal | null} why the relay last turned this Mac away; kept through the tries that follow, until a connection opens */
    this.refusal = null;
    this.forceToken = false;
    /** @type {RelaySocket | null} */
    this.socket = null;
    /** @type {'online' | 'sleeping'} */
    this.presence = 'online';
    /** @type {string[]} */
    this.queue = [];
    this.unanswered = 0;
    this.ackable = false;
    this.nextId = 0;
    /** @type {Map<string, { resolve: (value?: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
    this.waiting = new Map();
    /** @type {{ retry?: ReturnType<typeof setTimeout>, beat?: ReturnType<typeof setTimeout>, ready?: ReturnType<typeof setTimeout>, renew?: ReturnType<typeof setTimeout> }} */
    this.timers = {};
    /** @type {Record<string, Set<(v: any) => void>>} */
    this.handlers = { state: new Set(), open: new Set(), frame: new Set(), event: new Set(), error: new Set() };
  }

  /**
   * state: the connection state · open: the relay's hello (its pairs for this device) · frame: a frame for this Mac, as the wire
   * object · event: pair.joined / pair.removed / mailbox.dropped / peer (a phone came or went) · error: the relay refused something we sent ({ code, pair?, ctr? })
   * @param {'state' | 'open' | 'frame' | 'event' | 'error'} kind @param {(v: any) => void} fn @returns {() => void}
   */
  on(kind, fn) {
    this.handlers[kind].add(fn);
    return () => this.handlers[kind].delete(fn);
  }

  #emit(/** @type {string} */ kind, /** @type {unknown} */ v) {
    for (const fn of this.handlers[kind]) {
      try {
        fn(v);
      } catch (error) {
        noteIgnored(`tell a relay ${kind} listener`, error);
      }
    }
  }

  #setState(/** @type {RelayState} */ s) {
    if (this.state === s) return;
    this.state = s;
    this.#emit('state', s);
  }

  /** Opens the connection and keeps it open. Calling it again while it runs does nothing; after a revoke or a stop it starts over. */
  start() {
    if (this.state !== 'idle' && this.state !== 'revoked' && this.state !== 'stopped') return;
    this.failures = 0;
    this.refusals = 0;
    this.refusal = null;
    void this.#connect(++this.epoch);
  }

  /** Opens a fresh connection, so the relay sends again every frame not yet acknowledged (a connection never sees a frame twice). */
  reconnect() {
    if (this.socket) this.#drop(this.socket, 1000);
  }

  /** Closes the socket for good: no reconnect, queued frames and waiting requests are dropped; the relay sees a clean close (presence gone). */
  stop() {
    this.epoch++;
    this.#clearTimers();
    const s = this.socket;
    this.socket = null;
    this.queue = [];
    this.ackable = false;
    this.refusal = null;
    this.#failWaiting('The relay connection was closed');
    this.#setState('stopped');
    try {
      s?.close(1000);
    } catch (error) {
      noteIgnored('close the relay socket', error);
    }
  }

  async #connect(/** @type {number} */ epoch) {
    this.#setState('connecting');
    const token = await this.#token(this.forceToken);
    if (epoch !== this.epoch) return;
    this.forceToken = false;
    if (!token) return this.#retry(epoch, this.o.refused?.() ?? null);
    const url = this.o.url();
    // a token but no relay to show it to (a build without the MoPilot service, given an account some other way): wait as for none
    if (!url) return this.#retry(epoch);
    let socket;
    try {
      socket = this.createSocket(url, { authorization: `Bearer ${token}` });
    } catch (error) {
      noteIgnored('open the relay socket', error);
      return this.#retry(epoch);
    }
    this.socket = socket;
    this.unanswered = 0;
    socket.onopen = () => {
      if (epoch === this.epoch && this.socket === socket)
        this.timers.ready = setTimeout(() => this.#drop(socket, CLOSE_STALE), READY_TIMEOUT_MS);
    };
    socket.onmessage = (e) => epoch === this.epoch && this.socket === socket && this.#message(e.data);
    socket.onerror = () => noteIgnored('read the relay socket', new Error('socket error'));
    socket.onclose = (e) => {
      if (epoch !== this.epoch || this.socket !== socket) return;
      this.socket = null;
      this.ackable = false;
      this.#clearTimers();
      this.#failWaiting('The relay connection was lost');
      if (e?.code === CLOSE_REVOKED) return this.#setState('revoked');
      const refusal = refusalOf(e?.code);
      // a switched-off account's next token is asked of the account service, which says whether it still is
      if (e?.code === CLOSE_UNAUTHORIZED || refusal === 'disabled') this.forceToken = true;
      this.#retry(epoch, refusal);
    };
  }

  async #token(/** @type {boolean} */ force) {
    try {
      return (await this.o.getToken(force)) || null;
    } catch (error) {
      noteIgnored('read the account token for the relay', error);
      return null;
    }
  }

  /** Tries again later: after the usual short backoff, or after a refusal's long one (`refusal` says why the relay turned this Mac away). */
  #retry(/** @type {number} */ epoch, /** @type {RelayRefusal | null} */ refusal = null) {
    if (refusal) {
      const changed = this.refusal !== refusal;
      this.refusal = refusal;
      // a listener reads `refusal` on a state change: one that only changed its reason is told too
      if (this.state === 'refused' && changed) this.#emit('state', 'refused');
      this.#setState('refused');
      this.timers.retry = setTimeout(() => this.#connect(epoch), refusalWait(this.refusals++, this.random()));
      return;
    }
    this.refusal = null;
    this.#setState('backoff');
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.failures++);
    this.timers.retry = setTimeout(() => this.#connect(epoch), Math.round(wait * (0.5 + this.random() / 2)));
  }

  /** Ends a socket that went silent or never said hello; a socket that doesn't report its own close must not leave us stuck. */
  #drop(/** @type {RelaySocket} */ socket, /** @type {number} */ code) {
    try {
      socket.close(code);
    } catch (error) {
      noteIgnored('close the relay socket', error);
    }
    if (this.socket === socket) socket.onclose?.({ code });
  }

  #message(/** @type {unknown} */ data) {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (m?.t) {
      case 'hello':
        clearTimeout(this.timers.ready);
        this.failures = 0;
        this.refusals = 0;
        this.refusal = null;
        this.ackable = relayAcks(m);
        this.#setState('open');
        this.#raw({ t: 'presence', state: this.presence });
        for (const text of this.queue.splice(0)) this.#rawText(text);
        this.#beat();
        this.#renew();
        this.#emit('open', {
          pairs: Array.isArray(m.pairs) ? m.pairs : [],
          device: typeof m.device === 'string' ? m.device : null,
          peerEvents: m.peerEvents === true,
        });
        break;
      case 'frame':
        this.#emit('frame', { pair: m.pair, dir: m.dir, ctr: m.ctr, nonce: m.nonce, box: m.box });
        break;
      case 'event':
        this.#emit('event', m);
        break;
      case 'ok':
        if (m.op === 'presence') this.unanswered = 0;
        this.#settle(m.rid, null);
        break;
      case 'push.result':
        this.#settle(m.rid, null, m.status);
        break;
      case 'error':
        if (!this.#settle(m.rid, m.code)) this.#emit('error', { code: m.code, pair: m.pair, ctr: m.ctr });
        break;
    }
  }

  #settle(/** @type {unknown} */ rid, /** @type {string | null} */ failure, /** @type {unknown} */ value = undefined) {
    const w = typeof rid === 'string' ? this.waiting.get(rid) : undefined;
    if (!w) return false;
    this.waiting.delete(/** @type {string} */ (rid));
    clearTimeout(w.timer);
    if (failure) w.reject(Object.assign(new Error(`The relay refused: ${failure}`), { code: failure }));
    else w.resolve(value);
    return true;
  }

  #beat() {
    this.timers.beat = setTimeout(() => {
      // the timer is cleared whenever the socket goes, so this one is open
      const socket = /** @type {RelaySocket} */ (this.socket);
      if (this.unanswered >= MAX_UNANSWERED) return this.#drop(socket, CLOSE_STALE);
      this.unanswered++;
      this.#raw({ t: 'presence', state: this.presence });
      this.#beat();
    }, HEARTBEAT_MS);
  }

  /** The JWT is short-lived: the open socket gets a fresh one before the relay's grace runs out. */
  #renew() {
    this.timers.renew = setTimeout(async () => {
      const socket = this.socket;
      const token = await this.#token(false);
      if (token && this.socket === socket) this.#raw({ t: 'auth', token });
      if (this.socket === socket) this.#renew();
    }, RENEW_MS);
  }

  #raw(/** @type {object} */ m) {
    return this.#rawText(JSON.stringify(m));
  }

  #rawText(/** @type {string} */ text) {
    try {
      this.socket?.send(text);
      return true;
    } catch (error) {
      noteIgnored('send to the relay', error);
      return false;
    }
  }

  #clearTimers() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
  }

  #failWaiting(/** @type {string} */ why) {
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error(why));
      this.waiting.delete(id);
    }
  }

  /** A frame (the wire object: base64 nonce and box). @param {{ pair: string, dir: string, ctr: number, nonce: string, box: string }} frame @returns {'sent' | 'queued' | 'dropped'} */
  sendFrame(frame) {
    const text = JSON.stringify({ t: 'frame', pair: frame.pair, dir: frame.dir, ctr: frame.ctr, nonce: frame.nonce, box: frame.box });
    if (this.state === 'open') return this.#rawText(text) ? 'sent' : 'dropped';
    if (this.state === 'stopped' || this.state === 'revoked' || this.queue.length >= MAX_QUEUED) return 'dropped';
    this.queue.push(text);
    return 'queued';
  }

  /** One message for the relay that nothing answers (a download's bytes); false when the socket is not open or did not take it. @param {object} m */
  send(m) {
    return this.state === 'open' && this.#raw(m);
  }

  /** Whether the open connection's relay keeps frames until they are acknowledged. */
  get acks() {
    return this.state === 'open' && this.ackable;
  }

  /** Tells the relay a frame is durably held here, so it stops redelivering it. @param {{ pair: string, dir: string, ctr: number }} frame @returns {boolean} whether the socket took it */
  sendAck(frame) {
    return this.acks && this.#raw(encodeAck(frame));
  }

  /** Publishes presence now if the socket is open, and on every open. The Mac that quits calls stop(), which the relay reads as gone. @param {'online' | 'sleeping'} state */
  setPresence(state) {
    this.presence = state;
    if (this.state === 'open') this.#raw({ t: 'presence', state });
  }

  /** One request the relay answers with ok or error; rejects when the socket is down, the relay refuses, or it doesn't answer. @param {{ t: string, [k: string]: unknown }} m */
  request(m) {
    if (this.state !== 'open') return Promise.reject(new Error('The relay is not connected'));
    const rid = `r${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(rid);
        reject(new Error('The relay did not answer'));
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(rid, { resolve, reject, timer });
      if (!this.#raw({ ...m, rid })) {
        clearTimeout(timer);
        this.waiting.delete(rid);
        reject(new Error('The relay is not connected'));
      }
    });
  }

  /**
   * A push request in the clear ({pair, kind, ref}; the relay applies the merge rule and holds the phone's token); resolves with the relay's status (sent, suppressed, no_token, disabled, failed).
   * @param {{ pair: string, kind: string, ref: string, sealed?: string, card?: string, sealedBody?: string, sealedStamp?: string }} req `sealedStamp`: the lease of the MoMo home that sent it, sealed for the phone (shared/remote/stampSeal.mjs), forwarded unread by a relay that knows it and dropped by one that does not; the phone drops a push older than the newest lease it has seen. `sealed` is the chat title sealed for the phone; the relay forwards it unread. `card`: the opaque handle of MoMo's card a momoNeedsYou push is for (a relay that predates it drops it). `sealedBody`: MoMo's opt-in body (the user's own routine name) sealed for the phone, forwarded unread by a relay that knows it and dropped by one that does not
   * @returns {Promise<string>}
   */
  pushRequest({ pair, kind, ref, sealed, card, sealedBody, sealedStamp }) {
    return /** @type {Promise<string>} */ (
      this.request({
        t: 'push',
        pair,
        kind,
        ref,
        ...(sealed && { sealed }),
        ...(card && { card }),
        ...(sealedBody && { sealedBody }),
        ...(sealedStamp && { sealedStamp }),
      })
    );
  }

  /**
   * A snapshot of this Mac's chats for the phone's Live Activity ({needs, running, kind, since, at, rows}; see activityBridge.cjs); the relay keeps the latest per pair and answers like a push request (sent, no_token, disabled, failed).
   * @param {{ pair: string, state: object }} req
   * @returns {Promise<string>}
   */
  activityUpdate({ pair, state }) {
    return /** @type {Promise<string>} */ (this.request({ t: 'activity', pair, state }));
  }

  /** @param {string} pair */
  registerPair(pair) {
    return this.request({ t: 'pair.register', pair });
  }

  /** @param {string} pair */
  removePair(pair) {
    return this.request({ t: 'pair.remove', pair });
  }
}

module.exports = {
  RelayClient,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  HEARTBEAT_MS,
  MAX_UNANSWERED,
  READY_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  RENEW_MS,
  MAX_QUEUED,
  CLOSE_REVOKED,
  CLOSE_UNAUTHORIZED,
  CLOSE_STALE,
};
