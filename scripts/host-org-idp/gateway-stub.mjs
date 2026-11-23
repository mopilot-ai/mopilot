// A stand-in for a customer's LLM gateway (#3361 Tier 2), for dev and test only: it takes a bearer token (Authorization or x-api-key), checks it is the IdP's own (RS256 against the issuer's JWKS, issuer, audience, expiry) and answers Anthropic Messages and OpenAI Responses calls with a fixed reply naming who signed in. It never calls a vendor and never logs a token.
//   node scripts/host-org-idp/gateway-stub.mjs --issuer http://127.0.0.1:8080/realms/mopilot-test [--audience mopilot-gateway] [--port 8787] [--tool-turns N --tool-sleep S]
// Each line it logs names the token by a fingerprint (the first 8 hex of its SHA-256), so a renewal shows as a new one. With --tool-turns, an Anthropic call that offers
// a Bash tool is answered with `sleep S` until N tool results came back: a long turn, for checking that a running CLI picks up a renewed token.
// Anthropic base URL: http://127.0.0.1:<port>/anthropic   OpenAI base URL: http://127.0.0.1:<port>/openai/v1   Counts: GET /stats
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * @param {{ issuer: string, audience: string, fetch?: typeof fetch, now?: () => number }} o
 * @returns {(token: string) => Promise<{ ok: true, claims: Record<string, any> } | { ok: false, why: string }>}
 */
export function createVerifier({ issuer, audience, fetch: fetchFn = globalThis.fetch, now = Date.now }) {
  /** @type {Map<string, crypto.KeyObject>} */
  const keys = new Map();
  const load = async () => {
    const res = await fetchFn(`${issuer}/protocol/openid-connect/certs`);
    const { keys: list } = /** @type {{ keys: any[] }} */ (await res.json());
    for (const jwk of list) if (jwk.kid && jwk.kty === 'RSA') keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  };
  return async (token) => {
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return { ok: false, why: 'not a JWT' };
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString());
      claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    } catch {
      return { ok: false, why: 'unreadable' };
    }
    if (header.alg !== 'RS256') return { ok: false, why: 'alg' };
    if (!keys.has(header.kid)) await load();
    const key = keys.get(header.kid);
    if (!key) return { ok: false, why: 'unknown key' };
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) return { ok: false, why: 'signature' };
    if (claims.iss !== issuer) return { ok: false, why: 'issuer' };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) return { ok: false, why: 'audience' };
    if (!(claims.exp * 1000 > now())) return { ok: false, why: 'expired' };
    return { ok: true, claims };
  };
}

/** The bearer a request carries: Claude Code's key helper sends it as both headers, Codex as Authorization. @param {http.IncomingMessage} req */
export const bearerOf = (req) => {
  const auth = String(req.headers.authorization ?? '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-api-key'] ?? '').trim();
};

/** @param {http.ServerResponse} res @param {string} event @param {object} data */
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** A token's fingerprint, safe to log: the first 8 hex of its SHA-256. @param {string} token */
export const fingerprint = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);

/** How many tool results a Messages request carries. @param {any} body */
const toolResults = (body) =>
  (Array.isArray(body?.messages) ? body.messages : []).reduce(
    (n, m) => n + (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === 'tool_result').length : 0),
    0,
  );

/** A Bash tool call answer (`sleep`), streamed when asked. @param {http.ServerResponse} res @param {any} body @param {number} seconds */
function anthropicTool(res, body, seconds) {
  const id = `msg_stub_${crypto.randomUUID()}`;
  const model = body?.model ?? 'stub';
  const use = {
    type: 'tool_use',
    id: `toolu_${crypto.randomUUID().replaceAll('-', '')}`,
    name: 'Bash',
    input: { command: `sleep ${seconds}`, description: 'Wait' },
  };
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [use],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage,
      }),
    );
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { ...use, input: {} } });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(use.input) },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/** An Anthropic Messages answer: streamed when asked, else one message. @param {http.ServerResponse} res @param {any} body @param {string} text */
function anthropic(res, body, text) {
  const id = `msg_stub_${crypto.randomUUID()}`;
  const model = body?.model ?? 'stub';
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (!body?.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage,
      }),
    );
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/** An OpenAI Responses answer, streamed (what Codex reads). @param {http.ServerResponse} res @param {any} body @param {string} text */
function openai(res, body, text) {
  const id = `resp_stub_${crypto.randomUUID()}`;
  const item = {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const usage = {
    input_tokens: 1,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2,
  };
  const response = { id, object: 'response', model: body?.model ?? 'stub', status: 'completed', output: [item], usage };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, 'response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
  sse(res, 'response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  sse(res, 'response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
  sse(res, 'response.completed', { type: 'response.completed', response });
  res.end();
}

/**
 * @param {{ verify: ReturnType<typeof createVerifier>, log?: (line: string) => void, toolTurns?: number, toolSleep?: number }} o
 */
export function createGateway({ verify, log = () => undefined, toolTurns = 0, toolSleep = 30 }) {
  const stats = {
    accepted: 0,
    rejected: 0,
    /** @type {Record<string, number>} */ bySubject: {},
    /** @type {Record<string, number>} */ byWhy: {},
    /** @type {Record<string, number>} */ byToken: {},
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(String(req.url), 'http://stub');
    if (req.method === 'GET' && url.pathname === '/stats')
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const token = bearerOf(req);
    const verdict = token ? await verify(token) : { ok: /** @type {const} */ (false), why: 'no token' };
    const fp = token ? fingerprint(token) : '-';
    if (!verdict.ok) {
      stats.rejected++;
      stats.byWhy[verdict.why] = (stats.byWhy[verdict.why] ?? 0) + 1;
      log(`401 ${req.method} ${url.pathname} (${verdict.why}) token ${fp}`);
      const error = { type: 'error', error: { type: 'authentication_error', message: `gateway: ${verdict.why}` } };
      return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify(error));
    }
    const who = String(verdict.claims.preferred_username ?? verdict.claims.sub);
    stats.accepted++;
    stats.bySubject[who] = (stats.bySubject[who] ?? 0) + 1;
    stats.byToken[fp] = (stats.byToken[fp] ?? 0) + 1;
    log(`200 ${req.method} ${url.pathname} as ${who} token ${fp}`);
    /** @type {any} */
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const text = `gateway-ok:${who}`;
    if (url.pathname.startsWith('/anthropic/v1/messages/count_tokens'))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }));
    const offersBash = Array.isArray(body?.tools) && body.tools.some((/** @type {any} */ t) => t?.name === 'Bash');
    if (url.pathname.startsWith('/anthropic/v1/messages') && offersBash && toolResults(body) < toolTurns)
      return anthropicTool(res, body, toolSleep);
    if (url.pathname.startsWith('/anthropic/v1/messages')) return anthropic(res, body, text);
    if (url.pathname.startsWith('/openai/v1/responses')) return openai(res, body, text);
    if (url.pathname.startsWith('/openai/v1/models') || url.pathname.startsWith('/anthropic/v1/models'))
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [], object: 'list' }));
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `stub has no ${url.pathname}` } }));
  });
  return { server, stats };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      issuer: { type: 'string' },
      audience: { type: 'string', default: 'mopilot-gateway' },
      port: { type: 'string', default: '8787' },
      'tool-turns': { type: 'string', default: '0' },
      'tool-sleep': { type: 'string', default: '30' },
    },
  });
  if (!values.issuer) throw new Error('--issuer is required');
  const { server } = createGateway({
    verify: createVerifier({ issuer: values.issuer, audience: String(values.audience) }),
    log: (l) => console.log(l),
    toolTurns: Number(values['tool-turns']),
    toolSleep: Number(values['tool-sleep']),
  });
  server.listen(Number(values.port), '127.0.0.1', () => console.log(`gateway stub on http://127.0.0.1:${values.port}`));
  // stopped by a signal: closes and exits cleanly
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
