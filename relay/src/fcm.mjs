// FCM sender: HTTP v1 `messages:send` with an OAuth access token the service account (from config) mints by signing a
// JWT (RS256) and exchanging it at the token endpoint. The token is cached until shortly before it expires.
import { createPrivateKey, sign } from 'node:crypto';
import { retryAfterMs } from './pushRetry.mjs';
import { fcmMessage } from './pushPayload.mjs';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const SKEW_MS = 60_000;
const b64u = (/** @type {Buffer | string} */ v) => Buffer.from(v).toString('base64url');

/**
 * @param {{ serviceAccount: { client_email: string, private_key: string, project_id: string, token_uri?: string },
 *   fetch?: typeof fetch, now?: () => number, baseUrl?: string, timeoutMs?: number }} o
 * @returns {(m: import('./push.mjs').PushMessage) => Promise<import('./pushRetry.mjs').SendResult>}
 */
export function fcmSender({
  serviceAccount: sa,
  fetch: f = fetch,
  now = Date.now,
  baseUrl = 'https://fcm.googleapis.com',
  timeoutMs = 10_000,
}) {
  const key = createPrivateKey(sa.private_key);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  /** @type {{ value: string, until: number } | null} */
  let access = null;
  /** @type {Promise<string | null> | null} */
  let minting = null;

  const mint = async () => {
    const iat = Math.floor(now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat, exp: iat + 3600 }));
    const assertion = `${head}.${body}.${b64u(sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
    const res = await f(tokenUri, {
      signal: AbortSignal.timeout(timeoutMs),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const json = res.ok ? await res.json() : null;
    if (!json?.access_token) return null;
    access = { value: json.access_token, until: now() + (Number(json.expires_in) || 3600) * 1000 - SKEW_MS };
    return access.value;
  };

  const accessToken = () => {
    if (access && now() < access.until) return Promise.resolve(access.value);
    minting ??= mint()
      .catch(() => null)
      .finally(() => {
        minting = null;
      });
    return minting;
  };

  return async (m) => {
    const bearer = await accessToken();
    if (!bearer) return { ok: false, retry: true, fault: true };
    let res;
    try {
      res = await f(`${baseUrl}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
        signal: AbortSignal.timeout(timeoutMs),
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ message: fcmMessage(m) }),
      });
    } catch {
      return { ok: false, retry: true, fault: true };
    }
    if (res.ok) return { ok: true };
    if (res.status === 401) {
      access = null;
      return { ok: false, retry: true, fault: true };
    }
    const error = await res.json().then(
      (j) => j?.error,
      () => null,
    );
    const codes = [error?.status, ...(Array.isArray(error?.details) ? error.details.map((/** @type {any} */ d) => d?.errorCode) : [])];
    const badToken = error?.details?.some?.((/** @type {any} */ d) =>
      d?.fieldViolations?.some?.((/** @type {any} */ v) => v?.field === 'message.token'),
    );
    // the token is not usable by this project at all (UNREGISTERED, a malformed token, or one registered with another sender id)
    if (res.status === 404 || codes.includes('UNREGISTERED') || codes.includes('SENDER_ID_MISMATCH') || badToken)
      return { ok: false, invalidToken: true };
    // 5xx, or a credential the project refuses (403 PERMISSION_DENIED: the API is off, the account lacks the role) is the provider's or the relay's trouble;
    // a 429 (the quota may be one device's) or another 4xx (a payload) is not
    return {
      ok: false,
      retry: res.status === 429 || res.status >= 500,
      retryAfterMs: retryAfterMs(res.headers.get('retry-after'), now()),
      fault: res.status >= 500 || res.status === 403,
    };
  };
}
