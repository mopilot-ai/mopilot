// Token buckets for the relay's rate limits. A bucket refills at `perSecond` up to `burst`; taking from it says how long the
// caller must wait (0 when there is room). The relay waits that long before handling a frame, so a flood is slowed to the
// limit instead of refused, and a message that must not wait is refused with the delay it would have needed.

export class TokenBucket {
  /** @param {number} perSecond @param {number} burst @param {() => number} now */
  constructor(perSecond, burst, now) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }

  /** Takes `n` tokens (going into debt if there are not enough) and returns the milliseconds until the debt is paid. */
  take(n = 1) {
    const t = this.now();
    // a clock that steps back (an NTP correction, a resumed VM) adds nothing, rather than putting every bucket into debt
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, t - this.at) / 1000) * this.perSecond);
    this.at = t;
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.perSecond) * 1000);
  }

  /** Takes `n` tokens only if they are there; otherwise leaves the bucket alone and returns the wait. */
  tryTake(n = 1) {
    const t = this.now();
    const tokens = Math.min(this.burst, this.tokens + (Math.max(0, t - this.at) / 1000) * this.perSecond);
    if (tokens < n) return Math.ceil(((n - tokens) / this.perSecond) * 1000);
    this.tokens = tokens - n;
    this.at = t;
    return 0;
  }

  /** Whether the bucket is full again, so a registry can forget it. */
  get idle() {
    return this.tokens + (Math.max(0, this.now() - this.at) / 1000) * this.perSecond >= this.burst;
  }
}

/** Buckets by key (a pair id), created on first use and forgotten once full. */
export class Buckets {
  /** @param {number} perSecond @param {number} burst @param {() => number} now */
  constructor(perSecond, burst, now) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
    /** @type {Map<string, TokenBucket>} */
    this.map = new Map();
  }

  get(/** @type {string} */ key) {
    let b = this.map.get(key);
    if (!b) this.map.set(key, (b = new TokenBucket(this.perSecond, this.burst, this.now)));
    return b;
  }

  prune() {
    for (const [key, b] of this.map) if (b.idle) this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}
