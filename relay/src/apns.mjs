// APNs sender: HTTP/2 to Apple with a provider token (ES256 over the team id, signed with the p8 key from config). One
// session is kept and reopened when it closes. A result says whether to retry (429, 5xx, a lost connection, an expired
// provider token) and whether Apple called the device token dead (410, or 400 BadDeviceToken).
import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';
import { retryAfterMs } from './pushRetry.mjs';
import { apnsBody } from './pushPayload.mjs';

const TOKEN_TTL_MS = 30 * 60_000; // Apple wants a provider token refreshed between every 20 and 60 minutes
const b64u = (/** @type {Buffer | string} */ v) => Buffer.from(v).toString('base64url');

/**
 * @param {{ keyPem: string, keyId: string, teamId: string, topic: string, sandbox?: boolean, timeoutMs?: number, now?: () => number,
 *   connect?: (authority: string) => http2.ClientHttp2Session }} o `connect` is the test seam (a local h2c server)
 * @returns {(m: import('./push.mjs').PushMessage) => Promise<import('./pushRetry.mjs').SendResult>}
 */
export function apnsSender({ keyPem, keyId, teamId, topic, sandbox = false, timeoutMs = 10_000, now = Date.now, connect = http2.connect }) {
  const key = createPrivateKey(keyPem);
  const authority = sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  /** @type {http2.ClientHttp2Session | null} */
  let session = null;
  /** @type {{ jwt: string, at: number } | null} */
  let cached = null;

  const providerToken = () => {
    if (cached && now() - cached.at < TOKEN_TTL_MS) return cached.jwt;
    const head = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
    const body = b64u(JSON.stringify({ iss: teamId, iat: Math.floor(now() / 1000) }));
    const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    cached = { jwt: `${head}.${body}.${b64u(sig)}`, at: now() };
    return cached.jwt;
  };

  const open = () => {
    if (session && !session.closed && !session.destroyed) return session;
    const s = connect(authority);
    const forget = () => {
      if (session === s) session = null;
    };
    s.on('error', forget);
    s.on('close', forget);
    // Apple is closing this connection: new requests go to a fresh one, and this one ends once its requests do
    s.on('goaway', () => {
      forget();
      s.close();
    });
    session = s;
    return s;
  };

  return (m) =>
    new Promise((resolve) => {
      let status = 0;
      let retryAfter;
      const chunks = [];
      let done = false;
      const finish = (/** @type {import('./pushRetry.mjs').SendResult} */ r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      try {
        const req = open().request({
          ':method': 'POST',
          ':path': `/3/device/${encodeURIComponent(m.token)}`,
          authorization: `bearer ${providerToken()}`,
          // a Live Activity update has its own push type and topic suffix, and no collapse id (the activity's timestamp orders updates)
          'apns-topic': m.activity ? `${topic}.push-type.liveactivity` : topic,
          'apns-push-type': m.activity ? 'liveactivity' : 'alert',
          'apns-priority': m.activity ? String(m.activity.priority) : '10',
          ...(!m.activity && { 'apns-collapse-id': m.collapseId.slice(0, 64) }),
          'content-type': 'application/json',
        });
        const used = session;
        req.setTimeout(timeoutMs, () => {
          req.close(http2.constants.NGHTTP2_CANCEL);
          // the answer was a success and only its end was slow: Apple has the push, sending it again would show it twice
          if (status === 200) return finish({ ok: true });
          // nothing came back at all: the connection itself may be dead (or never made), so the next request opens another;
          // the requests still on it finish or time out on their own (close, not destroy)
          if (!status && used && session === used) {
            session = null;
            used.close();
          }
          finish({ ok: false, retry: true, fault: true });
        });
        req.on('response', (h) => {
          status = Number(h[':status']);
          retryAfter = retryAfterMs(/** @type {string | undefined} */ (h['retry-after']), now());
        });
        req.on('data', (c) => chunks.push(c));
        req.on('error', () => finish({ ok: false, retry: true, fault: true }));
        req.on('end', () => {
          if (status === 200) return finish({ ok: true });
          // the stream ended with no answer (its connection was closed under it): another try
          if (!status) return finish({ ok: false, retry: true, fault: true });
          let reason = '';
          try {
            reason = String(JSON.parse(Buffer.concat(chunks).toString()).reason ?? '').slice(0, 64);
          } catch {
            // an unreadable body leaves the status to decide
          }
          // Unregistered (410), a malformed token, or a token that belongs to another app: none will ever work for this topic.
          // The last two may only mean "not this credential set's app" (`wrongApp`); a 410 is final whichever set answered.
          if (status === 410) return finish({ ok: false, invalidToken: true, status, reason });
          if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))
            return finish({ ok: false, invalidToken: true, wrongApp: true, status, reason });
          if (status === 403 && reason === 'ExpiredProviderToken') {
            cached = null;
            return finish({ ok: false, retry: true, status, reason });
          }
          // a credential the provider refuses (401, 403) or a provider that is failing (5xx) is the relay's or the provider's trouble; a 429 or another 4xx belongs to the device or the payload
          finish({
            ok: false,
            retry: status === 429 || status >= 500,
            retryAfterMs: retryAfter,
            fault: status >= 500 || status === 401 || status === 403,
            status,
            reason,
          });
        });
        req.end(JSON.stringify(apnsBody(m)));
      } catch {
        session = null;
        finish({ ok: false, retry: true, fault: true });
      }
    });
}
