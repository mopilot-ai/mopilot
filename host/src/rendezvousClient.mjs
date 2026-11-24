// The Host's side of the relay's rendezvous (relay/src/rendezvousHttp.mjs, R2b of #5576): the four calls an offer makes, over HTTP, each answered as `{ ok: true, ... }` or `{ ok: false, reason }`. The address is the relay's HTTP base; the account token is sent only on the offer, never logged, never kept. A relay that is unreachable, slow or answers something else is a reason, never an exception the caller has to know about.

/** What a relay's answer may be (a relay is not trusted to send only what it should): the shapes the protocol and the relay's own tests fix. */
const OFFER_ID = /^r_[A-Za-z0-9_-]{22}$/;
const TICKET = /^[A-Za-z0-9_-]{22}$/;
const HINT = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/;
const BOX = /^[A-Za-z0-9_-]{1,2800}$/;
/** The most bytes of an answer that are read, the most messages one read carries, and the furthest an offer's end may be (the relay's offers last five minutes). */
export const MAX_BODY = 32_768;
export const MAX_MESSAGES = 6;
export const MAX_OFFER_MS = 10 * 60_000;
const count = (/** @type {unknown} */ v, /** @type {number} */ max) =>
  Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= max;

/** The reason a status answers: what the relay's own words say, or the kind of failure. @param {number} status @param {any} json */
const REASON = /^[a-z][a-z_]{0,31}$/;
const reasonOf = (status, json) => {
  // the relay's own word, when it is a short word (a reason ends up in the Host's messages and logs; whatever else the relay says is not kept)
  if (typeof json?.error === 'string' && REASON.test(json.error)) return json.error;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'gone';
  if (status === 429) return 'limited';
  return 'relay';
};

/** The text of an answer, read in pieces and given up on the moment it passes the bound (a relay that never stops sending is cut off, not waited for); null when it passes. @param {any} res @returns {Promise<string | null>} */
async function bounded(res) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const whole = await res.text();
    return whole.length > MAX_BODY ? null : whole;
  }
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
  }
}

/** @param {{ fetch?: typeof fetch, timeoutMs?: number }} [o] */
export function createRendezvousClient({ fetch: doFetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  /** @param {string} base @param {string} path @param {object} body @param {string} [token] @returns {Promise<{ ok: true, status: number, json: any } | { ok: false, reason: string }>} */
  async function post(base, path, body, token) {
    try {
      const res = await doFetch(new URL(path, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      const length = Number(res.headers?.get?.('content-length'));
      if (length > MAX_BODY) return { ok: false, reason: 'relay' };
      const text = res.status === 204 ? '' : await bounded(res);
      if (text === null) return { ok: false, reason: 'relay' };
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return res.status >= 200 && res.status < 300
        ? { ok: true, status: res.status, json }
        : { ok: false, reason: reasonOf(res.status, json) };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return {
    /** @param {{ base: string, token: string }} o */
    async offer({ base, token }) {
      const r = await post(base, '/v1/rendezvous/offer', {}, token);
      if (!r.ok) return r;
      const { id, hint, ticket, expiresAt } = r.json ?? {};
      // an offer the relay made that is not of the relay's own shapes is no offer, and one that outlasts an offer is cut to its length
      const valid = OFFER_ID.test(id) && HINT.test(hint) && TICKET.test(ticket) && Number.isFinite(expiresAt);
      return valid
        ? { ok: /** @type {const} */ (true), id, hint, ticket, expiresAt: Math.min(expiresAt, Date.now() + MAX_OFFER_MS) }
        : { ok: /** @type {const} */ (false), reason: 'relay' };
    },
    /** @param {{ base: string, id: string, ticket: string, after: number }} o */
    async read({ base, id, ticket, after }) {
      const r = await post(base, `/v1/rendezvous/${id}/read`, { ticket, after });
      if (!r.ok) return r;
      const { claims, expiresAt, messages } = r.json ?? {};
      const sound =
        count(claims, 5) &&
        Number.isFinite(expiresAt) &&
        Array.isArray(messages) &&
        messages.length <= MAX_MESSAGES &&
        messages.every((/** @type {any} */ m) => m && count(m.n, 1000) && m.n > 0 && typeof m.box === 'string' && BOX.test(m.box));
      return sound
        ? { ok: /** @type {const} */ (true), claims, expiresAt, messages }
        : { ok: /** @type {const} */ (false), reason: 'relay' };
    },
    /** @param {{ base: string, id: string, ticket: string, claims: number, box: string }} o */
    async send({ base, id, ticket, claims, box }) {
      const r = await post(base, `/v1/rendezvous/${id}/send`, { ticket, claims, box });
      return r.ok ? { ok: /** @type {const} */ (true) } : r;
    },
    /** @param {{ base: string, id: string, ticket: string }} o */
    async close({ base, id, ticket }) {
      const r = await post(base, `/v1/rendezvous/${id}/close`, { ticket });
      return r.ok ? { ok: /** @type {const} */ (true) } : r;
    },
  };
}
