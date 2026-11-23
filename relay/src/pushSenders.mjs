// The push path a relay's config selects: none, a dry run that only logs payload sizes, the push proxy, or direct APNs/FCM with
// the operator's own keys. Each provider send is wrapped in the retry policy, a circuit breaker (a provider that keeps failing is
// left alone for a cool-down; a push that failed after its retries counts once) and a limit on requests in flight; the direct
// sender routes by the token's platform.
import { apnsRouter } from './apnsRouter.mjs';
import { apnsSender } from './apns.mjs';
import { apnsSetsOf } from './config.mjs';
import { fcmSender } from './fcm.mjs';
import { proxySender } from './push.mjs';
import { apnsBody, fcmMessage } from './pushPayload.mjs';
import { CircuitBreaker, withBreaker, withLimit } from './pushGuard.mjs';
import { withRetry } from './pushRetry.mjs';

/**
 * A sender that sends nothing: it logs the platform, the kind, the fixed title and the size of the payload that would go out
 * (never a token, a chat handle or a sealed title), so an operator can check what a push would look like before holding keys.
 * @param {(event: string, data: object) => void} log
 * @returns {(m: import('./push.mjs').PushMessage) => Promise<import('./pushRetry.mjs').SendResult>}
 */
export function dryRunSender(log) {
  return async (m) => {
    // the body each sender posts: APNs's own JSON, FCM's wrapped in {message}
    const body = m.platform === 'apns' ? apnsBody(m) : { message: fcmMessage(m) };
    log('push_dry_run', { platform: m.platform, kind: m.kind, title: m.title, bytes: Buffer.byteLength(JSON.stringify(body)) });
    return { ok: true };
  };
}

/** One set's sender; a key APNs could never accept stops the relay at boot, naming the set (never the key). */
function apnsSenderOf(
  /** @type {import('./config.mjs').ApnsKeys} */ set,
  /** @type {Omit<Parameters<typeof apnsSender>[0], keyof import('./config.mjs').ApnsKeys>} */ deps,
) {
  try {
    return apnsSender({ ...set, ...deps });
  } catch {
    throw new Error(`The APNs key of topic ${set.topic} is not a valid p8 private key (PEM).`);
  }
}

/**
 * @param {import('./config.mjs').RelayConfig['push']} push
 * @param {{ retry?: Parameters<typeof withRetry>[1], fetch?: typeof fetch, connect?: Parameters<typeof apnsSender>[0]['connect'], now?: () => number, breakerNow?: () => number, fcmBaseUrl?: string,
 *   log?: (event: string, data: object) => void, metrics?: import('./metrics.mjs').Metrics }} [deps]
 * @returns {import('./push.mjs').PushSend | null}
 */
export function createSender(push, { retry, fetch: f, connect, now, breakerNow, fcmBaseUrl, log = () => undefined, metrics } = {}) {
  if (push.mode === 'none') return null;
  const timeoutMs = push.timeoutMs;
  /** One guarded path per provider: its own breaker, so a dead FCM does not hold back APNs. */
  const guarded = (
    /** @type {string} */ name,
    /** @type {(m: import('./push.mjs').PushMessage) => Promise<import('./pushRetry.mjs').SendResult>} */ raw,
  ) => {
    // the cool-down runs on the monotonic clock unless a test hands one in
    const breaker = new CircuitBreaker({
      failures: push.breakerFailures,
      cooldownMs: push.breakerCooldownMs,
      ...(breakerNow && { now: breakerNow }),
    });
    const observe = (/** @type {string} */ outcome, /** @type {CircuitBreaker} */ b) => {
      metrics?.inc('relay_push_provider_total', { provider: name, outcome }, 1, 'Push requests to a provider, by outcome');
      metrics?.set(
        'relay_push_breaker_open',
        b.state === 'closed' ? 0 : 1,
        { provider: name },
        '1 while a provider is on hold after repeated failures',
      );
      if (outcome === 'failed' && b.state === 'open' && b.consecutive === push.breakerFailures)
        log('push_breaker_open', { provider: name });
    };
    const limited = withLimit(withBreaker(withRetry(raw, retry), breaker, observe), { limit: push.maxInFlight });
    return async (/** @type {import('./push.mjs').PushMessage} */ m) => {
      const result = await limited(m);
      if (result.shed) observe('shed', breaker);
      return result;
    };
  };
  if (push.mode === 'dryrun') return guarded('dryrun', dryRunSender(log));
  if (push.mode === 'proxy') return guarded('proxy', proxySender({ url: push.proxyUrl, authToken: push.proxyToken, fetch: f, timeoutMs }));
  // one guarded sender (and breaker) per credential set: the first is `apns` in the metrics, the next `apns2`
  const sets = apnsSetsOf(push).map((set, i) => ({
    topic: set.topic,
    send: guarded(i ? `apns${i + 1}` : 'apns', apnsSenderOf(set, { connect, now, timeoutMs })),
  }));
  const apns = sets.length ? apnsRouter(sets) : null;
  const fcm = push.fcm ? guarded('fcm', fcmSender({ serviceAccount: push.fcm, fetch: f, now, baseUrl: fcmBaseUrl, timeoutMs })) : null;
  return async (m) => {
    const send = m.platform === 'apns' ? apns : fcm;
    return send ? send(m) : { ok: false };
  };
}
