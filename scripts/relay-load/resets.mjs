// Connection resets for the relay load harness: sockets of their own (not the fleet's) that are torn down with a TCP RST at each
// phase of a connection's life, as a phone going through a tunnel does. The run then checks that the relay process lived and the
// fleet's frames were neither lost nor duplicated. The accounts and pairs used here start with `abuse`, which the harness leaves out of its mailbox counts.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';

/** Where in a connection's life the reset lands. */
export const PHASES = /** @type {const} */ (['upgrade-partial', 'upgrade-auth', 'hello', 'mid-frame', 'close', 'ack']);

/** The pair ids and devices of these sockets: counted apart from the fleet's. */
export const ABUSE_PAIR_PREFIX = 'p_abuse';

/** Accounts and devices the resets rotate through: enough that two resets rarely share a device (the relay replaces a device's socket and limits its connects). */
const SLOTS = 64;
/** Resets under way at once; past it a reset is not made, so a high rate cannot swamp the harness or the relay. */
const MAX_RUNNING = 12;

/** A TCP RST, not a close handshake. */
const reset = (/** @type {net.Socket} */ socket) => void socket.resetAndDestroy();

/** A masked text frame header that promises 40000 bytes and delivers 100, so the relay is in the middle of a message when the socket dies. */
const halfFrame = () => Buffer.concat([Buffer.from([0x81, 0xfe, 0x9c, 0x40]), randomBytes(4), randomBytes(100)]);

/** @typedef {{ add(socket: { destroy(): unknown }): void }} Job */

export class Resets {
  /**
   * @param {object} o
   * @param {string} o.url ws://host:port/v1/ws
   * @param {(user: string, device: string, kind: 'desktop' | 'phone') => Promise<string>} o.sign
   * @param {number} [o.timeoutMs] how long one reset may take before it counts as not made
   */
  constructor({ url, sign, timeoutMs = 3000 }) {
    this.timeoutMs = timeoutMs;
    this.url = new URL(url);
    this.sign = sign;
    /** @type {Record<string, number>} resets done, by phase */
    this.done = Object.fromEntries(PHASES.map((p) => [p, 0]));
    /** how many resets could not be made (the relay was down or refused the socket) */
    this.skipped = 0;
    this.turn = 0;
    /** @type {Map<number, number>} the next counter of each slot's pair */
    this.counters = new Map();
    /** @type {Set<Promise<void>>} */
    this.running = new Set();
  }

  get total() {
    return Object.values(this.done).reduce((a, b) => a + b, 0);
  }

  /** One reset in every phase; the phases run side by side, as a crowd of bad connections would. */
  async round() {
    await Promise.all(PHASES.map((phase) => this.one(phase)));
  }

  /** Waits for the resets still under way (each ends within a few seconds). */
  async idle() {
    while (this.running.size) await Promise.all([...this.running]);
  }

  /** @param {typeof PHASES[number]} phase */
  one(phase) {
    const job = this.#one(phase);
    this.running.add(job);
    return job.finally(() => this.running.delete(job));
  }

  async #one(/** @type {typeof PHASES[number]} */ phase) {
    if (this.running.size > MAX_RUNNING) return void this.skipped++;
    const slot = this.turn++ % SLOTS;
    /** The sockets this reset opens: whatever happens to it, none outlives it (one opened after it gave up is destroyed as it is added). */
    const job = {
      over: false,
      /** @type {{ destroy(): unknown }[]} */
      sockets: [],
      add(/** @type {{ destroy(): unknown }} */ socket) {
        if (job.over) socket.destroy();
        else job.sockets.push(socket);
      },
    };
    try {
      await Promise.race([
        this.#run(phase, slot, job),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), this.timeoutMs).unref()),
      ]);
      this.done[phase]++;
    } catch {
      this.skipped++;
    } finally {
      job.over = true;
      for (const socket of job.sockets) socket.destroy();
    }
  }

  async #headers(/** @type {number} */ slot, /** @type {'desktop' | 'phone'} */ kind) {
    return { authorization: `Bearer ${await this.sign(`abuse-u${slot}`, `abuse-${kind[0]}${slot}`, kind)}` };
  }

  #request(/** @type {string} */ authorization) {
    return (
      `GET /v1/ws HTTP/1.1\r\nHost: ${this.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nAuthorization: ${authorization}\r\n\r\n`
    );
  }

  /** A raw TCP connection to the relay, resolved once connected. */
  #raw() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(Number(this.url.port), this.url.hostname, () => resolve(socket));
      socket.once('error', reject);
    });
  }

  async #run(/** @type {typeof PHASES[number]} */ phase, /** @type {number} */ slot, /** @type {Job} */ job) {
    if (phase === 'upgrade-partial' || phase === 'upgrade-auth') {
      const { authorization } = await this.#headers(slot, 'desktop');
      const socket = /** @type {net.Socket} */ (await this.#raw());
      job.add(socket);
      socket.on('error', () => undefined);
      const text = this.#request(authorization);
      // the second is reset the moment the request has gone out: the relay is checking the token when the socket dies
      if (phase === 'upgrade-partial') socket.write(text.slice(0, text.length >> 1));
      else await new Promise((resolve) => socket.write(text, () => resolve(undefined)));
      await new Promise((resolve) => setImmediate(resolve));
      return reset(socket);
    }
    const mac = await this.#open(slot, 'desktop', job);
    if (phase === 'hello') return reset(mac._socket);
    if (phase === 'mid-frame') {
      mac._socket.write(halfFrame());
      await new Promise((resolve) => setImmediate(resolve));
      return reset(mac._socket);
    }
    if (phase === 'close') {
      mac.close(1000);
      return reset(mac._socket);
    }
    await this.#ack(slot, mac, job);
  }

  /** @returns {Promise<any>} a socket that has opened (and not yet said hello) */
  async #open(/** @type {number} */ slot, /** @type {'desktop' | 'phone'} */ kind, /** @type {Job} */ job) {
    const ws = new WebSocket(this.url.href, { headers: await this.#headers(slot, kind) });
    job.add({ destroy: () => ws.terminate() });
    ws.on('error', () => undefined);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('close', () => reject(new Error('closed')));
    });
    return ws;
  }

  /** A pair of their own: the Mac sends a frame, the phone receives it, sends the receipt and is reset in the same breath. */
  async #ack(/** @type {number} */ slot, /** @type {any} */ mac, /** @type {Job} */ job) {
    const pair = `${ABUSE_PAIR_PREFIX}${String(slot).padStart(4, '0')}`;
    const phone = await this.#open(slot, 'phone', job);
    const ctr = (this.counters.get(slot) ?? 0) + 1;
    this.counters.set(slot, ctr);
    // the reset only counts if the phone really received the frame and sent its receipt: that is the moment it is reset in
    await new Promise((resolve, reject) => {
      const give = setTimeout(() => reject(new Error('the frame never reached the phone')), 1000);
      phone.on('message', (/** @type {Buffer} */ data) => {
        let m;
        try {
          m = JSON.parse(String(data));
        } catch {
          return;
        }
        if (m?.t !== 'frame') return;
        clearTimeout(give);
        phone.send(JSON.stringify({ t: 'ack', pair, dir: m.dir, ctr: m.ctr }));
        reset(phone._socket);
        resolve(undefined);
      });
      mac.send(JSON.stringify({ t: 'pair.register', pair }));
      phone.send(JSON.stringify({ t: 'pair.join', pair }));
      setTimeout(
        () =>
          mac.readyState === WebSocket.OPEN &&
          mac.send(
            JSON.stringify({
              t: 'frame',
              pair,
              dir: 'm2p',
              ctr,
              nonce: randomBytes(24).toString('base64'),
              box: randomBytes(64).toString('base64'),
            }),
          ),
        100,
      );
    });
    reset(phone._socket);
    reset(mac._socket);
  }
}
