// Computer access (#1364): one device's connection to this Mac, on the host. The handshake comes first (handshake.cjs):
// nothing the device sends is read as a request until both sides proved their keys, and from then on every message is
// an encrypted frame (frames.cjs). A frame that is malformed, replayed or out of order, a message of an unknown type
// and a handshake that does not finish in time all end the connection.
const { EventEmitter } = require('node:events');
const { hostRespond, hostFinish, HandshakeError } = require('./handshake.cjs');
const { SecureChannel } = require('./frames.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long the handshake may take. */
const HANDSHAKE_MS = 5000;
/** What a device may send once its connection is open. */
const REQUESTS = new Set(['tools', 'call', 'turnEnded', 'answer', 'ping']);

/** Close codes a device reads (4xxx: application codes). */
const CLOSE = {
  protocol: 4400,
  unauthorized: 4401,
  unknown_device: 4403,
  no_pairing: 4404,
  timeout: 4408,
  revoked: 4410,
  off: 4503,
};

/**
 * Why a message ended the connection: a handshake error's own code, a frame that was replayed or didn't decrypt as
 * unauthorized, anything else (JSON that doesn't parse, a malformed frame) as a protocol error.
 * @param {unknown} error @returns {keyof typeof CLOSE}
 */
function closeWhy(error) {
  const e = /** @type {any} */ (error);
  if (e instanceof HandshakeError && Object.hasOwn(CLOSE, e.code)) return /** @type {keyof typeof CLOSE} */ (e.code);
  if (e?.code === 'replay' || e?.code === 'unauthorized') return 'unauthorized';
  return 'protocol';
}

class HostConnection extends EventEmitter {
  /**
   * @param {{ ws: { send(text: string): boolean, close(code?: number, reason?: string): void, on(ev: string, fn: Function): any,
   *     setMaxBytes?: (n: number) => void },
   *   identity: () => { x: string, d: string }, known: (key: string) => boolean, pairSecret: () => string | null,
   *   handshakeMs?: number, openMaxBytes?: number }} o
   *   openMaxBytes: the largest message once the device proved its key (until then the socket takes only small ones)
   * Events: 'pair' ({ key, name, code }) a device proved the open pairing offer and waits for the person;
   * 'open' (key) a paired device proved its key; 'request' (message); 'close' (code, reason).
   */
  constructor(o) {
    super();
    this.ws = o.ws;
    this.o = o;
    /** @type {'hello' | 'confirm' | 'pairing' | 'open' | 'closed'} */
    this.phase = 'hello';
    /** @type {any} */
    this.state = null;
    /** @type {InstanceType<typeof SecureChannel> | null} */
    this.channel = null;
    /** @type {string | null} the device's key, once proved */
    this.key = null;
    /** @type {string | null} the paired device's id here, once open */
    this.deviceId = null;
    this.timer = setTimeout(() => this.close('timeout', 'no handshake'), o.handshakeMs ?? HANDSHAKE_MS);
    this.timer.unref?.();
    this.ws.on('message', (text) => this.#message(text));
    this.ws.on('close', (code, reason) => this.#gone(code, reason));
  }

  get open() {
    return this.phase === 'open';
  }

  #message(text) {
    try {
      if (this.phase === 'hello') return this.#hello(JSON.parse(text));
      if (this.phase === 'confirm') return this.#confirm(JSON.parse(text));
      // waiting for the person to allow a pairing: the device has nothing to say yet
      if (this.phase === 'pairing') return this.close('protocol', 'unexpected message while pairing');
      if (this.phase !== 'open') return;
      const m = /** @type {any} */ (this.channel).open(text);
      if (!m || typeof m !== 'object' || !REQUESTS.has(m.t)) return this.close('protocol', 'unknown request');
      if (m.t === 'ping') return this.send({ t: 'pong' });
      this.emit('request', m);
    } catch (error) {
      this.close(closeWhy(error), /** @type {Error} */ (error).message);
    }
  }

  #hello(m) {
    const r = hostRespond({ identity: this.o.identity(), hello: m, known: this.o.known, pairSecret: this.o.pairSecret });
    this.state = r.state;
    this.phase = 'confirm';
    this.ws.send(JSON.stringify(r.message));
  }

  #confirm(m) {
    const done = hostFinish({ state: this.state, confirm: m });
    clearTimeout(this.timer);
    this.state = null;
    this.channel = new SecureChannel(done.session);
    this.key = done.client;
    if (done.pair) {
      this.phase = 'pairing';
      this.emit('pair', { key: done.client, name: done.name, code: done.code });
      return;
    }
    // the device may have been revoked between its hello and its confirmation
    if (!this.o.known(done.client)) return this.close('unknown_device', 'This device is not paired with this Mac');
    this.#opened();
    this.emit('open', done.client);
  }

  /**
   * The person allowed the device this connection paired: it is open now, as a paired device's connection is.
   * @param {string} deviceId
   */
  admit(deviceId) {
    if (this.phase !== 'pairing') return false;
    this.#opened();
    this.deviceId = deviceId;
    return true;
  }

  /** The device proved its key: its messages may now be as large as a frame (a screenshot). */
  #opened() {
    this.phase = 'open';
    if (this.o.openMaxBytes) this.ws.setMaxBytes?.(this.o.openMaxBytes);
  }

  /** An encrypted message to the device; false when the connection can't carry one. */
  send(message) {
    if (!this.channel || this.phase === 'closed') return false;
    try {
      return this.ws.send(this.channel.seal(message));
    } catch (error) {
      noteIgnored('send a computer access message', error);
      return false;
    }
  }

  /**
   * Ends the connection with a reason the device reads.
   * @param {keyof typeof CLOSE} why @param {string} reason
   */
  close(why, reason) {
    if (this.phase === 'closed') return;
    this.ws.close(CLOSE[why] ?? CLOSE.protocol, String(reason).slice(0, 120));
    this.#gone(CLOSE[why] ?? CLOSE.protocol, reason);
  }

  #gone(code, reason) {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    clearTimeout(this.timer);
    this.emit('close', code, reason);
  }
}

module.exports = { HostConnection, CLOSE, REQUESTS, HANDSHAKE_MS, closeWhy };
