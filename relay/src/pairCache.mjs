// A short-lived cache of what the hub reads on every frame: a pair's row, and the pairs a device is on. Every change this
// process makes to a pair (register, join, remove, revoke) drops the entries it touched, so within one process the cache is
// never stale; the lifetime only bounds a change made behind the process's back (another instance, a manual repair).

export class PairCache {
  /** @param {() => number} now @param {number} ttlMs */
  constructor(now, ttlMs) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, { value: any, at: number }>} */
    this.entries = new Map();
    /** bumped by every drop: a load that began before one is not stored, so a read racing a change cannot put the old row back */
    this.generation = 0;
  }

  /** @template T @param {string} key @param {() => Promise<T>} load @param {boolean} [keepMissing] whether a null answer is kept too (a pair that is not there is not: asking for ids that do not exist must not fill the cache) @returns {Promise<T>} */
  async get(key, load, keepMissing = true) {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const started = this.generation;
    const value = await load();
    if (started === this.generation && (keepMissing || value != null)) this.entries.set(key, { value, at: this.now() });
    return value;
  }

  /** Forgets the pair row and the pair list of every device named. */
  drop(/** @type {string} */ pairId, /** @type {(string | null | undefined)[]} */ devices = []) {
    this.generation++;
    this.entries.delete(`pair:${pairId}`);
    for (const d of devices) if (d) this.entries.delete(`device:${d}`);
  }

  clear() {
    this.generation++;
    this.entries.clear();
  }
}
