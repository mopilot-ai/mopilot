// One signed Oracle Cloud Infrastructure request (signature version 1) with an injected `fetch` and signer, and the words for an error response. The adapter (oci.mjs) makes its calls through it, and so does the acceptance run's read-only look at a compartment, so both sign the same way.
import { CloudError } from './adapter.mjs';

/** @param {string} body */
async function sha256B64(body) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...digest));
}

/** The words for an error response: OCI's `code` and `message` fields, never the request. @param {number} status @param {any} body */
export function failure(status, body) {
  const code = String(body?.code ?? '');
  const message = String(body?.message ?? '').slice(0, 300);
  if (status === 401 || status === 403 || code === 'NotAuthenticated') return new CloudError('refused', 'That key was refused.');
  if (status === 404) return new CloudError('gone', 'That machine is gone at the provider.');
  if (code === 'OutOfHostCapacity' || /out of (host )?capacity/i.test(message))
    return new CloudError('capacity', message || 'The provider has no capacity for that size here.');
  if (code === 'LimitExceeded' || code === 'QuotaExceeded')
    return new CloudError('limit', message || 'The account is at its limit for that size.');
  if (status === 409 || code === 'IncorrectState')
    return new CloudError('busy', message || 'The machine is changing state.', {
      retryable: true,
    });
  if (status === 429 || status >= 500) return new CloudError('failed', message || 'The provider is not answering.', { retryable: true });
  return new CloudError('failed', message || `The provider answered ${status}.`);
}

/**
 * @param {object} o
 * @param {{ tenancy: string, user: string, fingerprint: string, region: string }} o.config
 * @param {typeof fetch} o.fetch
 * @param {(signingString: string) => string | Promise<string>} o.sign RSA-SHA256 over the string, base64: the key stays with the caller
 * @param {() => Date} [o.now]
 * @returns {(method: string, service: 'iaas' | 'identity', path: string, body?: any) => Promise<any>}
 */
export function createOciCall({ config: c, fetch: doFetch, sign, now = () => new Date() }) {
  const keyId = `${c.tenancy}/${c.user}/${c.fingerprint}`;
  /** @param {'iaas' | 'identity'} service */
  const hostOf = (service) => `${service}.${c.region}.oraclecloud.com`;

  /**
   * One signed call. A body goes as JSON with its hash in the signature, as the signature reference requires for POST and PUT.
   * @param {string} method @param {'iaas' | 'identity'} service @param {string} path with its query, in the order it is sent @param {any} [body]
   */
  return async function call(method, service, path, body) {
    const host = hostOf(service);
    const date = now().toUTCString();
    /** @type {Record<string, string>} */
    const headers = { date, host };
    let names = ['date', '(request-target)', 'host'];
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(new TextEncoder().encode(payload).length);
      headers['x-content-sha256'] = await sha256B64(payload);
      names = [...names, 'content-length', 'content-type', 'x-content-sha256'];
    }
    const lines = names.map((n) =>
      n === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${path}` : `${n}: ${headers[n]}`,
    );
    const signature = await sign(lines.join('\n'));
    headers.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`;
    /** @type {Response} */
    let res;
    try {
      res = await doFetch(`https://${host}${path}`, {
        method,
        headers,
        body: payload,
      });
    } catch {
      throw new CloudError('failed', 'MoPilot could not reach the provider.', {
        retryable: true,
      });
    }
    const text = await res.text();
    /** @type {any} */
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) throw failure(res.status, parsed);
    return parsed;
  };
}
