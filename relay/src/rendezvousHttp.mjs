// The HTTP face of the rendezvous (rendezvous.mjs), off unless RENDEZVOUS=1 (then every path here is unknown, like any the relay does not have): `POST /v1/rendezvous/offer` (a Host's credential or an account token), `POST /v1/rendezvous/claim` (nobody in particular, held to the caller's limits), and `POST /v1/rendezvous/<id>/send|read|close` (the ticket the offer or the claim gave). The id is in the path and the ticket in the body. Answers are JSON; every refusal that is about a code (no such hint, used up, expired, wrong id, ticket or claim) is the same 404 `no_such_code`, so nothing tells a guess how close it was. A page in a browser cannot use it: a request that carries an Origin is refused, and a body that is not `application/json` is refused, which a page can only send after a preflight this relay answers 405. Nothing here logs an id, a hint or a ticket.
import { accountDisabled } from './access.mjs';
import { clientAddress } from './address.mjs';
import { isHostToken, verifyHost } from './hosts.mjs';
import { MAX_BOX_CHARS } from './rendezvous.mjs';

const BODY_BYTES = MAX_BOX_CHARS + 512;
const ROUTE = /^\/v1\/rendezvous\/(offer|claim|(r_[A-Za-z0-9_-]{22})\/(send|read|close))$/;
const NO_SUCH_CODE = { error: 'no_such_code' };
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

/** @param {import('node:http').IncomingMessage} req */
const bearer = (req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

/** The JSON object of a request's body, or null when it is too big, not JSON or not an object. @param {import('node:http').IncomingMessage} req */
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {object | null} [json] @param {Record<string, string>} [headers] */
const reply = (res, status, json = null, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(json) : undefined);
};

/** The account an offer is made for: a Host's own credential, else an account token; `limited` for an address whose failed credentials ran out, `disabled` for an account switched off. @param {import('./hub.mjs').Hub} hub @param {{ verify: Function }} verifier @param {import('node:http').IncomingMessage} req @param {string} address @returns {Promise<string | null | 'limited' | 'disabled'>} */
async function accountOf(hub, verifier, req, address) {
  const token = bearer(req) ?? '';
  const found = isHostToken(token) ? await verifyHost(hub, token, address) : await verifier.verify(token);
  if (found === 'limited') return 'limited';
  if (!found || typeof found !== 'object') return null;
  return (await accountDisabled(hub, found)) ? 'disabled' : found.userId;
}

/**
 * Serves a rendezvous request; false for a path that is not one (or when the service is off).
 * @param {object} o
 * @param {import('node:http').IncomingMessage} o.req @param {import('node:http').ServerResponse} o.res @param {string} o.path
 * @param {import('./hub.mjs').Hub} o.hub @param {{ verify: Function }} o.verifier @param {boolean | undefined} o.trustProxy
 */
export async function serveRendezvous({ req, res, path, hub, verifier, trustProxy }) {
  const rv = hub.rendezvous;
  const route = rv ? ROUTE.exec(path) : null;
  if (!rv || !route) return false;
  // a preflight (OPTIONS) and anything else that is not a POST is 405: a page cannot send the JSON a POST needs without one
  if (req.method !== 'POST') return reply(res, 405, null, { allow: 'POST' }), true;
  if (req.headers.origin !== undefined) return reply(res, 403, { error: 'origin' }), true;
  if (!JSON_TYPE.test(String(req.headers['content-type']))) return reply(res, 415, { error: 'json_only' }), true;
  const address = clientAddress(req, trustProxy);
  if (route[1] === 'offer') {
    const account = await accountOf(hub, verifier, req, address);
    if (account === 'limited') return reply(res, 429, { error: 'limited' }, { 'retry-after': '10' }), true;
    if (account === 'disabled') return reply(res, 403, { error: 'disabled' }), true;
    if (!account) return reply(res, 401), true;
    const made = rv.offer({ account, address });
    if (!made.ok) return reply(res, made.reason === 'busy' ? 503 : 429, { error: made.reason }, { 'retry-after': '30' }), true;
    return reply(res, 200, { id: made.id, hint: made.hint, ticket: made.ticket, expiresAt: made.expiresAt }), true;
  }
  const json = await body(req);
  if (!json) return reply(res, 400, { error: 'bad_request' }), true;
  if (route[1] === 'claim') {
    const got = rv.claim({ hint: json.hint, address });
    if (got === 'limited') return reply(res, 429, { error: 'limited' }, { 'retry-after': '30' }), true;
    return got ? reply(res, 200, got) : reply(res, 404, NO_SUCH_CODE), true;
  }
  const [id, what] = [/** @type {string} */ (route[2]), route[3]];
  if (what === 'close') return rv.close({ id, ticket: json.ticket }) ? reply(res, 204) : reply(res, 404, NO_SUCH_CODE), true;
  const done =
    what === 'send'
      ? rv.send({ id, ticket: json.ticket, claims: json.claims, box: json.box })
      : rv.read({ id, ticket: json.ticket, after: json.after });
  if (done.ok) return reply(res, 200, 'n' in done ? { n: done.n } : done), true;
  const status = { gone: 404, bad: 400, full: 409, wait: 409, limited: 429 }[done.reason];
  return (
    reply(
      res,
      status,
      done.reason === 'gone' ? NO_SUCH_CODE : { error: done.reason },
      done.reason === 'limited' ? { 'retry-after': '2' } : {},
    ),
    true
  );
}
