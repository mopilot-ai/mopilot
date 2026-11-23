// MoPilot 12-Grid Bench (#1381) usage-limit injection for F8: the provider proxy's decision for each model request
// (pass it through, or answer once with the usage-limit error a subscription gives), armed per run by the runner.

/**
 * The error Anthropic's API gives when an account's usage limit is reached: 429 with a rate_limit_error body and the
 * unified rate-limit headers Claude Code reads. `resetAt` is when the limit lifts (epoch seconds).
 * @param {number} resetAt
 */
export function limitResponse(resetAt) {
  return {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': '60',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': String(resetAt),
    },
    body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Claude AI usage limit reached|' + resetAt } }),
  };
}

/** Whether a proxied request is a model request (the ones that count, and the ones that can be refused). @param {string} method @param {string} path */
export const isModelRequest = (method, path) => method === 'POST' && /^\/v1\/messages(?:\?|$)/.test(path);

/**
 * The proxy's limiter: disarmed until the runner arms it for a run; then it lets `afterRequests` model requests
 * through and refuses the next one, once, and records when. Every request after that passes again (the limit lifted),
 * so recovery can be graded.
 * @param {() => number} [clock]
 */
export function createLimiter(clock = () => Date.now()) {
  /** @type {{ tag: string, afterRequests: number, seen: number, limitedAt: number | null } | null} */
  let armed = null;
  return {
    /** @param {string} tag @param {number} afterRequests */
    arm(tag, afterRequests) {
      if (!tag || !Number.isInteger(afterRequests) || afterRequests < 1)
        throw new Error('arm needs a run tag and afterRequests of 1 or more');
      armed = { tag, afterRequests, seen: 0, limitedAt: null };
    },
    disarm() {
      armed = null;
    },
    /** The run's state for the grader: how many model requests passed, and when the limit hit. */
    state: () => (armed ? { tag: armed.tag, seen: armed.seen, limitedAt: armed.limitedAt } : null),
    /**
     * What to do with one request: 'pass' or 'limit'.
     * @param {string} method @param {string} path
     */
    decide(method, path) {
      if (!armed || !isModelRequest(method, path)) return 'pass';
      if (armed.limitedAt === null && armed.seen >= armed.afterRequests) {
        armed.limitedAt = clock();
        return 'limit';
      }
      armed.seen++;
      return 'pass';
    },
  };
}
