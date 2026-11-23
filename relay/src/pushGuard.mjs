// Protection around a push provider: a circuit breaker (after a run of failures the provider is left alone for a cool-down,
// then probed with one request), and a limit on how many requests are in flight (a stalled provider must not pile up
// requests, memory and connections). They wrap a push as the retry policy (pushRetry.mjs) returns it: one failure counts
// once however many attempts it took.

/** @typedef {import('./pushRetry.mjs').SendResult & { breakerOpen?: boolean, shed?: boolean }} GuardedResult */

export class CircuitBreaker {
  /** @param {{ failures?: number, cooldownMs?: number, maxCooldownMs?: number, now?: () => number }} [o] `now` is a monotonic clock: a step of the wall clock must not stretch or cut a cool-down */
  constructor({ failures = 5, cooldownMs = 30_000, maxCooldownMs = 300_000, now = () => performance.now() } = {}) {
    this.threshold = failures;
    this.baseCooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.now = now;
    this.consecutive = 0;
    this.cooldownMs = cooldownMs;
    this.open = false;
    /** @type {number} when the open breaker lets one probe through */
    this.openUntil = 0;
    this.probing = false;
  }

  /** @returns {'closed' | 'open' | 'half-open'} */
  get state() {
    if (!this.open) return 'closed';
    return this.now() >= this.openUntil && !this.probing ? 'half-open' : 'open';
  }

  /** Whether a request may go to the provider now. After the cool-down exactly one request is let through as a probe. */
  allow() {
    if (!this.open) return true;
    if (this.now() < this.openUntil || this.probing) return false;
    this.probing = true;
    return true;
  }

  success() {
    this.consecutive = 0;
    this.open = false;
    this.probing = false;
    this.cooldownMs = this.baseCooldownMs;
  }

  failure() {
    this.consecutive++;
    if (this.probing) {
      // the probe failed: back to open, for twice as long
      this.probing = false;
      this.cooldownMs = Math.min(this.maxCooldownMs, this.cooldownMs * 2);
      this.openUntil = this.now() + this.cooldownMs;
    } else if (this.consecutive >= this.threshold && !this.open) {
      this.open = true;
      this.openUntil = this.now() + this.cooldownMs;
    }
  }
}

/**
 * Counts how a provider answered, for the breaker and for the metrics. Only a `fault` counts against the provider (a network
 * error, a timeout, a 5xx, a credential it refuses): a dead device token, a 429 for one device's rate and a payload it rejects are
 * answers, and an answer shows the provider is up (it is also what closes a probing breaker).
 * @param {(m: import('./push.mjs').PushMessage) => Promise<import('./pushRetry.mjs').SendResult>} send
 * @param {CircuitBreaker} breaker
 * @param {(outcome: 'sent' | 'invalid_token' | 'failed' | 'rejected' | 'breaker_open' | 'shed', breaker: CircuitBreaker) => void} [observe]
 * @returns {(m: import('./push.mjs').PushMessage) => Promise<GuardedResult>}
 */
export function withBreaker(send, breaker, observe = () => undefined) {
  return async (m) => {
    if (!breaker.allow()) {
      observe('breaker_open', breaker);
      return { ok: false, breakerOpen: true };
    }
    /** @type {import('./pushRetry.mjs').SendResult} */
    let result;
    try {
      result = await send(m);
    } catch {
      result = { ok: false, retry: true, fault: true };
    }
    if (result.fault) breaker.failure();
    else breaker.success();
    observe(result.ok ? 'sent' : result.invalidToken ? 'invalid_token' : result.fault ? 'failed' : 'rejected', breaker);
    return result;
  };
}

/**
 * At most `limit` calls run at once and `queue` wait; the next is shed with `{ ok: false, shed: true }` at once.
 * @param {(m: import('./push.mjs').PushMessage) => Promise<GuardedResult>} send
 * @param {{ limit?: number, queue?: number }} [o]
 * @returns {(m: import('./push.mjs').PushMessage) => Promise<GuardedResult>}
 */
export function withLimit(send, { limit = 32, queue = 200 } = {}) {
  let running = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  return async (m) => {
    if (running >= limit) {
      if (waiting.length >= queue) return { ok: false, shed: true };
      await new Promise((resolve) => waiting.push(() => resolve(undefined)));
    } else running++;
    try {
      return await send(m);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
