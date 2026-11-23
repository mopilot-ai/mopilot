// The model router (plan Part B): one 127.0.0.1 server per app that a harness reaches as its own vendor, sending each
// request on to the provider a model config names (forward.cjs). A harness is given only a base under a random path,
// `http://127.0.0.1:<port>/<path secret>/c/<config id>`, and a token it sends as its API key; the provider's key stays in
// main. A request without both is not found, as on any other port.
const http = require('node:http');
const crypto = require('node:crypto');
const { listenLoopback } = require('../platform/listenLoopback.cjs');
const { readAll, fail } = require('../platform/loopbackHttp.cjs');
const { sameText } = require('../platform/timingSafe.cjs');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');
const { forward, errorBody } = require('./forward.cjs');

/** The largest request a harness sends (a long conversation with images and PDFs). */
const BODY_MAX = 64 * 1024 * 1024;
/** The paths under a config's base the router answers: Claude Code's Messages API. */
const MESSAGES = 'v1/messages';
const COUNT_TOKENS = 'v1/messages/count_tokens';

/** Refuse in Anthropic's shape, which Claude Code shows as it is. @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
const refuse = (res, status, message) => fail(res, status, message, errorBody(status, message));

/** The token a request carries as its API key: Claude Code sends ANTHROPIC_AUTH_TOKEN as a bearer, a key as x-api-key. @param {import('node:http').IncomingHttpHeaders} h */
function tokenOf(h) {
  const bearer = /^Bearer (.+)$/i.exec(String(h.authorization ?? ''));
  return bearer ? bearer[1] : typeof h['x-api-key'] === 'string' ? h['x-api-key'] : null;
}

/**
 * A rough count of a request's input tokens, for `count_tokens`: the router can't ask every provider, and Claude Code
 * uses the count only to show how full the context is. About four characters a token.
 * @param {Record<string, any>} parsed
 */
const estimateTokens = (parsed) => Math.ceil(JSON.stringify([parsed.system ?? '', parsed.messages ?? [], parsed.tools ?? []]).length / 4);

/**
 * @param {Omit<import('./forward.cjs').ForwardDeps, 'bases'> & {
 *   configs: { get(id: string): import('./configs.cjs').ModelConfig | null },
 *   bases?: Record<string, string>,
 *   random?: (size: number) => Buffer,
 *   listen?: typeof listenLoopback,
 *   bodyMax?: number,
 * }} deps `configs`, `keys`: the stores (configs.cjs, providerKeys.cjs); the rest for tests
 */
function createRouter(deps) {
  const { random = crypto.randomBytes, listen = listenLoopback, bodyMax = BODY_MAX, bases = {} } = deps;
  const pathSecret = random(18).toString('hex');
  const token = random(24).toString('hex');
  /** @type {{ server: import('node:http').Server, abort: AbortController, connections: Set<import('node:net').Socket>, ready: Promise<string> } | null} */
  let run = null;
  /** `http://127.0.0.1:<port>` while listening. @type {string | null} */
  let origin = null;

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function onRequest(req, res) {
    const url = new URL(/** @type {string} */ (req.url), 'http://127.0.0.1');
    const [, secret, c, id, ...rest] = url.pathname.split('/');
    if (!sameText(secret, pathSecret) || c !== 'c') return refuse(res, 404, 'Not found.');
    // the path was this app's: say why the key is wrong (Claude Code's own settings can set another). Not 401, which says the
    // provider refused the config's key
    if (!sameText(tokenOf(req.headers), token))
      return refuse(
        res,
        403,
        "That isn't the key MoPilot gave Claude Code for your own provider. Claude Code's settings.json may set its own (env.ANTHROPIC_AUTH_TOKEN or apiKeyHelper): remove it to use your own provider.",
      );
    const path = rest.join('/');
    if (req.method !== 'POST' || (path !== MESSAGES && path !== COUNT_TOKENS))
      return refuse(res, 404, "MoPilot's model router answers only Claude Code's /v1/messages.");
    const config = deps.configs.get(id);
    if (!config) return refuse(res, 404, 'This model config was removed. Choose another way to pay for Claude Code in Settings.');
    let body;
    try {
      body = await readAll(req, bodyMax);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'too_large') return res.destroy();
      res.shouldKeepAlive = false;
      return refuse(res, 413, 'The request is too large.');
    }
    const parsed = parseJsonRecord(body.toString('utf8'));
    if (!parsed.ok) return refuse(res, 400, 'The request body is not a JSON object.');
    if (path === COUNT_TOKENS) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimateTokens(parsed.record) }));
    }
    await forward(res, { config, body, parsed: parsed.record, headers: req.headers, search: url.search }, { ...deps, bases });
  }

  return {
    /** The token a harness sends as its API key. */
    token,
    /** Listen (again, after a stop); resolves to the origin. A second call while open shares the first. */
    start() {
      if (run) return run.ready;
      const server = http.createServer(
        (req, res) => void onRequest(req, res).catch(() => refuse(res, 502, "MoPilot's model router failed.")),
      );
      const abort = new AbortController();
      /** @type {Set<import('node:net').Socket>} */
      const connections = new Set();
      server.on('connection', (s) => {
        connections.add(s);
        s.on('close', () => connections.delete(s));
      });
      const ready = listen(server, 0, abort.signal, 'model router').then((port) => (origin = `http://127.0.0.1:${port}`));
      const opened = { server, abort, connections, ready };
      run = opened;
      // a failed listen can be tried again
      ready.catch(() => void (run === opened && (run = null)));
      return ready;
    },
    /** Stop listening and cut every connection. */
    stop() {
      const r = run;
      run = null;
      origin = null;
      if (!r) return;
      r.abort.abort();
      for (const s of r.connections) s.destroy();
      r.server.close();
    },
    /** The base a harness reaches config `id` at (its SDK appends `/v1/messages`); null until listening. @param {string} id */
    baseFor: (id) => (origin ? `${origin}/${pathSecret}/c/${id}` : null),
  };
}

/** @typedef {ReturnType<typeof createRouter>} ModelRouter */

module.exports = { createRouter, estimateTokens };
