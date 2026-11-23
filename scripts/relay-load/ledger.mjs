// The harness's books: for each pair and direction, which frames the relay accepted (acked to the sender) and which the
// receiver got. At the end an accepted frame nobody received is LOST; within one connection a repeat is a DUPLICATE and a
// lower counter after a higher one is REORDERED. A frame seen again on a later connection is only a redelivery (the relay
// is at-least-once; the endpoints' counters drop the repeat), counted apart.

export class Ledger {
  constructor() {
    /** @type {Map<string, { accepted: Set<number>, received: Set<number>, conn: number, last: number, seen: Set<number> }>} */
    this.streams = new Map();
    this.totals = { created: 0, accepted: 0, received: 0, redelivered: 0, duplicated: 0, reordered: 0, corrupt: 0, phantom: 0 };
  }

  #stream(/** @type {string} */ key) {
    let s = this.streams.get(key);
    if (!s) this.streams.set(key, (s = { accepted: new Set(), received: new Set(), conn: -1, last: 0, seen: new Set() }));
    return s;
  }

  created() {
    this.totals.created++;
  }

  accepted(/** @type {string} */ key, /** @type {number} */ ctr) {
    const s = this.#stream(key);
    if (s.accepted.has(ctr)) return;
    s.accepted.add(ctr);
    this.totals.accepted++;
  }

  /**
   * @param {string} key pair and direction
   * @param {number} ctr
   * @param {number} conn the receiving connection's number
   * @returns {'new' | 'redelivered' | 'duplicated' | 'reordered'}
   */
  received(key, ctr, conn) {
    const s = this.#stream(key);
    if (s.conn !== conn) {
      s.conn = conn;
      s.last = 0;
      s.seen = new Set();
    }
    const first = !s.received.has(ctr);
    let outcome = /** @type {'new' | 'redelivered' | 'duplicated' | 'reordered'} */ ('new');
    if (s.seen.has(ctr)) outcome = 'duplicated';
    else if (ctr < s.last) outcome = 'reordered';
    else if (!first) outcome = 'redelivered';
    s.last = Math.max(s.last, ctr);
    s.seen.add(ctr);
    s.received.add(ctr);
    if (first) this.totals.received++;
    if (outcome !== 'new') this.totals[outcome]++;
    return outcome;
  }

  corrupt() {
    this.totals.corrupt++;
  }

  phantom() {
    this.totals.phantom++;
  }

  /** Accepted frames nobody has received, as `<pair>:<dir>:<ctr>`. */
  unreceived() {
    const keys = [];
    for (const [key, s] of this.streams) for (const ctr of s.accepted) if (!s.received.has(ctr)) keys.push(`${key}:${ctr}`);
    return keys;
  }

  /** Accepted frames nobody has received: the loss the acks are meant to make impossible. */
  lost() {
    return this.unreceived().length;
  }

  /** Whether every accepted frame has reached its receiver. */
  settled() {
    return this.lost() === 0;
  }

  /**
   * @param {Set<string>} [inMailbox] `<pair>:<dir>:<ctr>` of every frame the relay still holds (leave it empty when that is unknown: every
   * unreceived frame then counts as LOST). An unreceived frame it holds is only UNDELIVERED (time ran out); one it no longer holds is LOST.
   */
  report(inMailbox = new Set()) {
    const unreceived = this.unreceived();
    const undelivered = unreceived.filter((k) => inMailbox.has(k)).length;
    return { ...this.totals, lost: unreceived.length - undelivered, undelivered };
  }
}
