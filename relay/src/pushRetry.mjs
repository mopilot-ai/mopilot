// Retry for one provider send: a result marked `retry` (HTTP 429, 5xx, a dropped connection) is tried again with
// exponential backoff, or after the provider's own Retry-After, up to a few attempts. Anything else is final.

/**
 * @typedef {{ ok: boolean, invalidToken?: boolean, wrongApp?: boolean, breakerOpen?: boolean, topic?: string, retry?: boolean, retryAfterMs?: number, fault?: boolean, status?: number, reason?: string }} SendResult
 *   fault: the provider, the connection or the relay's credential failed (not the device or the payload); wrongApp: the token is refused as belonging to another app, which another APNs credential set may still accept; breakerOpen: the set's breaker answered instead of APNs;
 *   topic: the APNs topic of the credential set that answered (only when the relay holds more than one)
 * @param {(m: import('./push.mjs').PushMessage) => Promise<SendResult>} send
 * @param {{ attempts?: number, baseMs?: number, maxMs?: number, sleep?: (ms: number) => Promise<void> }} [o]
 * @returns {import('./push.mjs').PushSend}
 */
export function withRetry(send, { attempts = 3, baseMs = 500, maxMs = 5_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return async (m) => {
    /** @type {SendResult} */
    let result = { ok: false };
    for (let i = 0; i < attempts; i++) {
      result = await send(m).catch(() => ({ ok: false, retry: true, fault: true }));
      if (result.ok || !result.retry) break;
      if (i < attempts - 1) await sleep(Math.min(maxMs, result.retryAfterMs ?? baseMs * 2 ** i));
    }
    return {
      ok: result.ok,
      ...(result.invalidToken && { invalidToken: true }),
      ...(result.wrongApp && { wrongApp: true }),
      ...(result.fault && { fault: true }),
      ...(result.status && { status: result.status }),
      ...(result.reason && { reason: result.reason }),
    };
  };
}

/** Seconds (or an HTTP date) from a Retry-After header, as milliseconds; undefined when absent or unusable. */
export function retryAfterMs(/** @type {string | null | undefined} */ v, now = Date.now()) {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}
