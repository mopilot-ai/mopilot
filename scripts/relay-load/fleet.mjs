// The population of the relay load harness: N paired Macs and phones, the traffic they send (a steady Poisson stream and
// bursts), the chaos done to them (killed sockets) and the check that every frame the relay accepted arrived.
import { Ledger } from './ledger.mjs';
import { Peer } from './peer.mjs';
import { Latency } from './stats.mjs';

/** Frame sizes of a chat session: mostly small deltas, now and then a tool output or a diff. */
const SIZES = [
  [0.7, 400],
  [0.9, 2048],
  [0.98, 16 * 1024],
  [1, 128 * 1024],
];

/** @param {number} u a uniform number in [0, 1) */
export const pickSize = (u) => (SIZES.find(([upTo]) => u < upTo) ?? SIZES[SIZES.length - 1])[1];

export class Fleet {
  /**
   * @param {object} o
   * @param {string} o.url ws://host:port/v1/ws
   * @param {(user: string, device: string, kind: 'desktop' | 'phone') => Promise<string>} o.sign
   * @param {number} o.pairs
   * @param {() => number} [o.now] epoch milliseconds
   * @param {{ reconnectMs?: [number, number], refreshMs?: number }} [o.options]
   */
  constructor({ url, sign, pairs, now = () => performance.timeOrigin + performance.now(), options }) {
    this.now = now;
    this.ledger = new Ledger();
    this.latency = { all: new Latency(), steady: new Latency() };
    /** @type {{ mac: Peer, phone: Peer }[]} */
    this.pairs = [];
    this.stopped = false;
    /** @type {Set<NodeJS.Timeout>} */
    this.timers = new Set();
    const sink = {
      record: (/** @type {string} */ _key, /** @type {Peer} */ receiver, /** @type {number} */ sentAt, /** @type {string} */ outcome) =>
        this.#record(receiver, sentAt, outcome),
    };
    for (let i = 0; i < pairs; i++) {
      const user = `load-u${i}`;
      const pairId = `p_load${String(i).padStart(6, '0')}`;
      const make = (/** @type {'mac' | 'phone'} */ role) =>
        new Peer({
          url,
          role,
          index: i,
          pairId,
          ledger: this.ledger,
          sink,
          now,
          options,
          token: () => sign(user, role === 'mac' ? `load-m${i}` : `load-p${i}`, role === 'mac' ? 'desktop' : 'phone'),
        });
      this.pairs.push({ mac: make('mac'), phone: make('phone') });
    }
  }

  get peers() {
    return this.pairs.flatMap((p) => [p.mac, p.phone]);
  }

  get socketsUp() {
    return this.peers.filter((p) => p.ready).length;
  }

  #record(/** @type {Peer} */ receiver, /** @type {number} */ sentAt, /** @type {string} */ outcome) {
    if (outcome !== 'new') return;
    const at = this.now();
    const ms = at - sentAt;
    this.latency.all.record(ms);
    const pair = this.pairs[receiver.index];
    const sender = receiver.role === 'mac' ? pair.phone : pair.mac;
    // steady: neither end connected, disconnected or was handed a hello since the frame was created
    if (sender.lastEventAt < sentAt && receiver.lastEventAt < sentAt) this.latency.steady.record(ms);
  }

  /** Connects every peer (`concurrency` at a time) and pairs each Mac with its phone. */
  async setup(concurrency = 100) {
    const failures = [];
    for (let i = 0; i < this.pairs.length; i += concurrency) {
      await Promise.all(
        this.pairs.slice(i, i + concurrency).map(async ({ mac, phone }) => {
          await Promise.all([mac.start(), phone.start()]);
          const reg = await mac.request({ t: 'pair.register', pair: mac.pairId });
          const join = reg.t === 'ok' ? await phone.request({ t: 'pair.join', pair: mac.pairId }) : reg;
          if (join.t !== 'ok') failures.push(`${mac.pairId}: ${join.code}`);
        }),
      );
    }
    if (failures.length) throw new Error(`pairing failed for ${failures.length} pairs: ${failures.slice(0, 3).join(', ')}`);
  }

  /** Every peer sends frames at `macRate` / `phoneRate` per second, at exponential intervals. */
  startTraffic({ macRate = 0.5, phoneRate = 0.05 } = {}) {
    for (const { mac, phone } of this.pairs) {
      this.#poisson(mac, macRate);
      this.#poisson(phone, phoneRate);
    }
  }

  #poisson(/** @type {Peer} */ peer, /** @type {number} */ rate) {
    if (!(rate > 0)) return;
    const wait = () => (-Math.log(1 - Math.random()) / rate) * 1000;
    // one timer per peer at a time: the set holds the live ones only, so a long soak does not grow it
    const arm = () => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        peer.createFrame(pickSize(Math.random()));
        arm();
      }, wait());
      this.timers.add(timer);
    };
    arm();
  }

  /** `pairs` Macs each send `frames` frames of `size` bytes back to back. */
  burst({ pairs, frames, size }) {
    for (const { mac } of this.pairs.slice(0, pairs)) for (let i = 0; i < frames; i++) mac.createFrame(size);
  }

  /** Cuts up to `count` random connected sockets (they reconnect on their own); returns how many it cut. */
  killSockets(count) {
    const peers = this.peers.filter((p) => p.ready);
    let cut = 0;
    for (; cut < count && peers.length; cut++) peers.splice(Math.floor(Math.random() * peers.length), 1)[0].kill();
    return cut;
  }

  stopTraffic() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Waits (up to `timeoutMs`) until the relay has accepted every frame, every accepted frame has arrived and the receipts emptied the mailbox (`depth`). */
  async drain(timeoutMs = 60_000, depth = async () => 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.peers.forEach((p) => p.flush(10_000));
      if (this.peers.every((p) => !p.pending.size) && this.ledger.settled() && (await this.#left(depth)) === 0) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** The mailbox depth, or -1 when the database cannot answer right now (the drain then waits and asks again). */
  async #left(/** @type {() => Promise<number>} */ depth) {
    try {
      return await depth();
    } catch {
      return -1;
    }
  }

  stop() {
    this.stopTraffic();
    for (const p of this.peers) p.stop();
  }

  /** @param {Set<string>} [inMailbox] what the relay still holds, to tell lost from undelivered (see Ledger.report) */
  report(inMailbox) {
    const peers = this.peers;
    const errors = /** @type {Record<string, number>} */ ({});
    const closes = /** @type {Record<string, number>} */ ({});
    for (const p of peers) {
      for (const [code, n] of Object.entries(p.stats.errors)) errors[code] = (errors[code] ?? 0) + n;
      for (const [code, n] of Object.entries(p.stats.closes)) closes[code] = (closes[code] ?? 0) + n;
    }
    return {
      ledger: this.ledger.report(inMailbox),
      latency: { all: this.latency.all.summary(), steady: this.latency.steady.summary() },
      client: {
        resends: peers.reduce((n, p) => n + p.stats.resends, 0),
        reconnects: peers.reduce((n, p) => n + p.stats.reconnects, 0),
        errors,
        closes,
        unaccepted: peers.reduce((n, p) => n + p.pending.size, 0),
      },
    };
  }
}
