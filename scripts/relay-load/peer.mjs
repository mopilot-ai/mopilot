// One end of a pair for the relay load harness: a Mac or a phone with a socket that reconnects, a queue of frames the relay
// has not accepted yet (resent after every reconnect, as the real endpoints do), and a receipt for every frame it is given.
import WebSocket from 'ws';
import { frameText, makeNonce, readBox } from './payload.mjs';

export class Peer {
  /**
   * @param {object} o
   * @param {string} o.url
   * @param {() => Promise<string>} o.token a fresh account token (used on every connect and every refresh)
   * @param {'mac' | 'phone'} o.role
   * @param {number} o.index the pair's number
   * @param {string} o.pairId
   * @param {import('./ledger.mjs').Ledger} o.ledger
   * @param {{ record(kind: string, peer: Peer, sentAt: number, outcome: string): void }} o.sink told about every frame this peer receives
   * @param {() => number} o.now
   * @param {{ reconnectMs?: [number, number], refreshMs?: number, helloTimeoutMs?: number }} [o.options]
   */
  constructor({ url, token, role, index, pairId, ledger, sink, now, options = {} }) {
    this.url = url;
    this.token = token;
    this.role = role;
    this.index = index;
    this.pairId = pairId;
    this.ledger = ledger;
    this.sink = sink;
    this.now = now;
    this.reconnectMs = options.reconnectMs ?? [100, 1500];
    this.refreshMs = options.refreshMs ?? 600_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 15_000;
    this.sendDir = /** @type {'m2p' | 'p2m'} */ (role === 'mac' ? 'm2p' : 'p2m');
    this.recvDir = this.sendDir === 'm2p' ? 'p2m' : 'm2p';
    /** @type {WebSocket | null} */
    this.ws = null;
    this.conn = 0;
    this.ready = false;
    this.stopped = false;
    this.lastEventAt = 0;
    this.ctr = 0;
    /** @type {Map<number, { text: string, attempts: number, at: number }>} frames the relay has not acked yet */
    this.pending = new Map();
    /** @type {Map<string, (m: any) => void>} */
    this.requests = new Map();
    /** @type {(() => void)[]} */
    this.helloWaiters = [];
    this.stats = {
      resends: 0,
      reconnects: 0,
      errors: /** @type {Record<string, number>} */ ({}),
      closes: /** @type {Record<string, number>} */ ({}),
    };
    this.failures = 0;
    /** @type {NodeJS.Timeout | null} */
    this.refresh = null;
  }

  get key() {
    return `${this.index}:${this.sendDir}`;
  }

  get inKey() {
    return `${this.index}:${this.recvDir}`;
  }

  /** Opens the socket and resolves with the first hello; rejects when the relay does not say hello in time (down, or refusing the token). */
  async start() {
    if (this.stopped) return;
    this.refresh = setInterval(() => this.#refreshToken(), this.refreshMs).unref();
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const hello = new Promise((resolve, reject) => {
      this.helloWaiters.push(() => resolve(undefined));
      timer = setTimeout(() => reject(new Error(`no hello from the relay for ${this.pairId} ${this.role}`)), this.helloTimeoutMs);
    });
    void this.#open();
    try {
      await hello;
    } finally {
      clearTimeout(timer);
    }
  }

  async #open() {
    if (this.stopped) return;
    let ws;
    try {
      const token = await this.token();
      // a stop that came while the token was being fetched must not leave a socket behind
      if (this.stopped) return;
      ws = new WebSocket(this.url, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      return this.#later();
    }
    this.ws = ws;
    const conn = ++this.conn;
    ws.on('message', (data) => this.#message(String(data), conn));
    ws.on('error', () => {
      // the close event that follows a failed connect or a broken socket does the reconnecting
    });
    ws.on('close', (code) => this.#closed(code));
  }

  #closed(/** @type {number} */ code) {
    this.stats.closes[code] = (this.stats.closes[code] ?? 0) + 1;
    this.ws = null;
    this.ready = false;
    this.lastEventAt = this.now();
    for (const [rid, resolve] of this.requests) resolve({ t: 'error', code: 'closed', rid });
    this.requests.clear();
    this.failures++;
    this.#later();
  }

  #later() {
    if (this.stopped) return;
    const [min, max] = this.reconnectMs;
    const delay = Math.min(5000, (min + Math.random() * (max - min)) * 2 ** Math.max(0, Math.min(this.failures - 1, 3)));
    this.stats.reconnects++;
    setTimeout(() => this.#open(), delay).unref();
  }

  #message(/** @type {string} */ text, /** @type {number} */ conn) {
    const m = JSON.parse(text);
    if (m.t === 'hello') {
      this.ready = true;
      this.failures = 0;
      this.lastEventAt = this.now();
      this.flush();
      for (const w of this.helloWaiters.splice(0)) w();
    } else if (m.t === 'frame') this.#received(m, conn);
    else if (m.t === 'ack' && m.dir === this.sendDir) {
      this.pending.delete(m.ctr);
      this.ledger.accepted(this.key, m.ctr);
    } else if (m.rid && this.requests.has(m.rid)) {
      this.requests.get(m.rid)?.(m);
      this.requests.delete(m.rid);
    } else if (m.t === 'error') {
      this.stats.errors[m.code] = (this.stats.errors[m.code] ?? 0) + 1;
      if (m.code === 'mailbox_full') setTimeout(() => this.flush(), 1000).unref();
    }
  }

  #received(/** @type {any} */ m, /** @type {number} */ conn) {
    const box = readBox(Buffer.from(m.box, 'base64'));
    this.#send({ t: 'ack', pair: this.pairId, dir: m.dir, ctr: m.ctr });
    const misrouted = m.dir !== this.recvDir || m.pair !== this.pairId;
    if (misrouted || !box || box.pair !== this.index || box.dir !== m.dir || box.ctr !== m.ctr) return void this.ledger.phantom();
    if (!box.intact || m.nonce !== makeNonce(box.pair, box.dir, box.ctr).toString('base64')) this.ledger.corrupt();
    const outcome = this.ledger.received(this.inKey, m.ctr, conn);
    this.sink.record(this.inKey, this, box.sentAt, outcome);
  }

  #send(/** @type {object | string} */ m) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
    return true;
  }

  /** A request/response over the socket (pair.register, pair.join). */
  request(/** @type {object} */ m, timeoutMs = 10_000) {
    const rid = `r${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => (this.requests.delete(rid), resolve({ t: 'error', code: 'timeout' })), timeoutMs).unref();
      this.requests.set(rid, (reply) => (clearTimeout(timer), resolve(reply)));
      if (!this.#send({ ...m, rid })) {
        this.requests.delete(rid);
        clearTimeout(timer);
        resolve({ t: 'error', code: 'closed' });
      }
    });
  }

  /** Creates the next frame and sends it if the socket is up; otherwise it waits for the next hello. */
  createFrame(/** @type {number} */ size) {
    const ctr = ++this.ctr;
    const entry = { text: frameText(this.pairId, this.index, this.sendDir, ctr, size, this.now()), attempts: 0, at: 0 };
    this.pending.set(ctr, entry);
    this.ledger.created();
    if (this.ready) this.#attempt(entry);
  }

  #attempt(/** @type {{ text: string, attempts: number, at: number }} */ entry) {
    if (entry.attempts) this.stats.resends++;
    if (this.#send(entry.text)) {
      entry.attempts++;
      entry.at = Date.now();
    }
  }

  /** Sends every frame the relay has not accepted for at least `olderThanMs`, oldest first. */
  flush(olderThanMs = 0) {
    if (!this.ready) return;
    for (const entry of this.pending.values()) if (Date.now() - entry.at >= olderThanMs) this.#attempt(entry);
  }

  async #refreshToken() {
    this.#send({ t: 'auth', token: await this.token() });
  }

  /** Cuts the socket without a close handshake, as a dropped network does. */
  kill() {
    this.ws?.terminate();
  }

  stop() {
    this.stopped = true;
    if (this.refresh) clearInterval(this.refresh);
    this.ws?.terminate();
  }
}
