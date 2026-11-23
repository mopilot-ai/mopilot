// One Claude Code request sent on by the model router (router.cjs) under a model config: the config's model in place of
// the request's (a Claude family the CLI names, such as its haiku helper, to the config's tier model), tried on the
// config's provider and then each fallback in order within one deadline, translated through the Rust core
// (platform/llmRoute.cjs) when the provider speaks another wire, and streamed back with a no-progress exit. A key goes
// only to its own provider's address and never back to the caller; a failure comes back as an Anthropic error, never a
// reply that looks finished, and never by falling back to the user's subscription or another key.
const http = require('node:http');
const https = require('node:https');
const llmRoute = require('../platform/llmRoute.cjs');
const { readAll } = require('../platform/loopbackHttp.cjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');
const { scrub } = require('../../shared/scrub.cjs');
const { llmProvider, keySlotFor } = require('../../shared/llmProviders.mjs');
const { TIERS } = require('./configs.cjs');

/** How long the attempts together may take to start a reply, how long a started reply may go without getting further, and how long a refusal's text is waited for (ms). */
const TIMEOUTS = Object.freeze({ deadline: 10 * 60_000, quiet: 5 * 60_000, refusal: 15_000 });
/** A whole reply, and the part of a refusal read for its message. */
const REPLY_MAX = 64 * 1024 * 1024;
const REFUSAL_MAX = 16 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * A key in the header its provider reads it from (shared/llmProviders.mjs AUTH_STYLES): the styles of the wires sent to so
 * far (Gemini's x-goog-api-key comes with its spoke). @type {Record<string, (key: string) => Record<string, string>>}
 */
const AUTH_HEADERS = {
  bearer: (key) => ({ authorization: `Bearer ${key}` }),
  'x-api-key': (key) => ({ 'x-api-key': key }),
};

/**
 * @typedef {import('./configs.cjs').ModelConfig} ModelConfig
 * @typedef {{ provider: string, model: string, baseUrl?: string }} Attempt
 * @typedef {(url: string, o: { headers: Record<string, string>, body: Buffer, signal: AbortSignal }) => Promise<import('node:http').IncomingMessage>} Send
 * @typedef {{ keys: { get(slot: string): string | null }, translate?: Pick<typeof llmRoute, 'translateRequest' | 'translateResponse' | 'StreamTranslator'>,
 *   send?: Send, bases: Record<string, string>, timeouts?: Partial<typeof TIMEOUTS>, now?: () => number }} ForwardDeps `bases`: a test's
 *   address per provider, in place of its own
 */

/** An attempt that failed: its words for the user, the status the caller gets, and whether a reply had already started. */
class Failed extends Error {
  /** @param {string} message @param {number} status @param {boolean} [started] */
  constructor(message, status, started = false) {
    super(message);
    this.status = status;
    this.started = started;
  }
}

/**
 * The model a request goes to: one the config names, as asked; else the config's tier model for the Claude family the
 * request names (Claude Code's `haiku` helper); else the config's model.
 * @param {ModelConfig} config @param {unknown} requested
 */
function pickModel(config, requested) {
  const own = [config.model, ...Object.values(config.tierModels)];
  if (typeof requested === 'string' && own.includes(requested)) return requested;
  const family = typeof requested === 'string' ? TIERS.find((t) => requested.toLowerCase().includes(t)) : undefined;
  return (family && config.tierModels[/** @type {'opus' | 'sonnet' | 'haiku'} */ (family)]) || config.model;
}

/** The config's provider at `model`, then its fallbacks in order; a custom server's fallback is on the config's own server. @param {ModelConfig} config @param {string} model @returns {Attempt[]} */
const attemptsOf = (config, model) => [
  { provider: config.provider, model, baseUrl: config.baseUrl },
  ...config.fallbacks.map((f) => ({ ...f, baseUrl: llmProvider(f.provider)?.customBase ? config.baseUrl : undefined })),
];

/** A provider's address is http only on loopback or a private network (shared/llmProviders.mjs checkBaseUrl). */
const CLIENTS = { 'http:': http, 'https:': https };

/** @type {Send} */
function sendHttp(url, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const up = CLIENTS[/** @type {'http:' | 'https:'} */ (u.protocol)].request(u, {
      method: 'POST',
      headers: { ...headers, 'content-length': body.length },
      signal,
    });
    up.on('response', resolve);
    up.on('error', reject);
    up.end(body);
  });
}

/**
 * The status the caller gets for a provider's: limits stay limits, a provider's own trouble is a bad gateway, a refused key is
 * a refused key (Claude Code names the key it was given), and any other refusal is the request's. @param {number} status
 */
const callerStatus = (status) => (status === 429 ? 429 : status >= 500 ? 502 : status === 401 || status === 403 ? 401 : 400);

/** An Anthropic error body. @param {number} status @param {string} message */
function errorBody(status, message) {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 429
          ? 'rate_limit_error'
          : status === 404
            ? 'not_found_error'
            : status === 413
              ? 'request_too_large'
              : status < 500
                ? 'invalid_request_error'
                : 'api_error';
  return { type: 'error', error: { type, message } };
}

/** An Anthropic stream's error event, for a reply that can't go on. @param {string} message */
const errorEvent = (message) => Buffer.from(`event: error\ndata: ${JSON.stringify(errorBody(502, message))}\n\n`);

/** Text a provider sent, without the key and anything else that looks like a secret, cut short. @param {string} text @param {string | null} key */
function clean(text, key) {
  const plain = key ? text.split(key).join('[key]') : text;
  const s = String(scrub(plain.replace(/\s+/g, ' ').trim()));
  return s.length > 300 ? `${prefixUnits(s, 300)}…` : s;
}

/** A provider's refusal in words: its JSON error's message, else its text. @param {Buffer} raw @param {string | null} key */
function refusalText(raw, key) {
  const parsed = parseJsonRecord(raw.toString('utf8'));
  /** @type {any} */
  const err = parsed.ok ? (parsed.record.error ?? parsed.record) : null;
  const text = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : raw.toString('utf8');
  return clean(text, key) || 'no reason given';
}

/**
 * The first `limit` bytes of a provider's refusal, once it has them, ends, breaks off or `wait` ms pass: a refusal cut short is
 * still the refusal its status says, one that never ends is let go by the attempt, and one that stalls holds no fallback up.
 * @param {import('node:http').IncomingMessage} u @param {number} limit @param {number} wait @returns {Promise<Buffer>}
 */
function firstBytes(u, limit, wait) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const parts = [];
    let size = 0;
    const done = () => (clearTimeout(timer), resolve(Buffer.concat(parts).subarray(0, limit)));
    const timer = setTimeout(done, wait);
    u.on('data', (/** @type {Buffer} */ d) => {
      parts.push(d);
      size += d.length;
      if (size >= limit) done();
    });
    u.on('end', done);
    u.on('close', done);
    u.on('error', (error) => (noteIgnored("read a provider's refusal", error), done()));
  });
}

/** Whether an Anthropic stream's bytes say only that it is still there (pings, comments): getting no further. @param {Buffer} chunk */
const pingOnly = (chunk) =>
  chunk
    .toString('utf8')
    .split('\n')
    // the text after the last line break is a line still arriving: it says nothing yet
    .slice(0, -1)
    .every(
      (line) =>
        !line.trim() || line.startsWith(':') || /^event: ?ping$/.test(line.trim()) || /^data: ?\{"type": ?"ping"\}$/.test(line.trim()),
    );

/**
 * Send `body` (a Claude Code `/v1/messages` request, parsed as `parsed`) under `config`, answering on `res`.
 * @param {import('node:http').ServerResponse} res
 * @param {{ config: ModelConfig, body: Buffer, parsed: Record<string, any>, headers: import('node:http').IncomingHttpHeaders, search: string }} request
 * @param {ForwardDeps} deps
 */
async function forward(res, { config, body, parsed, headers, search }, deps) {
  const now = deps.now ?? Date.now;
  const timeouts = { ...TIMEOUTS, ...deps.timeouts };
  const deadline = now() + timeouts.deadline;
  const gone = new AbortController();
  res.on('close', () => void (res.writableFinished || gone.abort()));
  /** @type {Failed[]} */
  const failures = [];
  for (const attempt of attemptsOf(config, pickModel(config, parsed.model))) {
    if (gone.signal.aborted) return;
    // one that ran out the deadline already says so
    if (deadline - now() <= 0) {
      if (!failures.length) failures.push(new Failed('The providers took too long to answer.', 504));
      break;
    }
    try {
      return await attemptOne(res, attempt, { body, parsed, headers, search }, { ...deps, timeouts, deadline, now, gone: gone.signal });
    } catch (error) {
      const e = error instanceof Failed ? error : new Failed(clean(messageOf(error), null), 502);
      // a reply already under way ended in an error event: there is nothing to fall back from
      if (e.started) return;
      failures.push(e);
    }
  }
  // every reply sent returned above; a caller that left hears nothing
  if (gone.signal.aborted) return;
  const last = /** @type {Failed} */ (failures.at(-1));
  const message = failures.length > 1 ? failures.map((f, i) => `${i ? 'Fallback ' : ''}${f.message}`).join(' ') : last.message;
  res.writeHead(last.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(errorBody(last.status, message)));
}

/**
 * One attempt: the provider's request, its answer, and the reply on `res`. Resolves once the reply was sent; throws a
 * Failed the next attempt may follow (started: false), or one that ended a started reply (started: true).
 * @param {import('node:http').ServerResponse} res @param {Attempt} attempt
 * @param {{ body: Buffer, parsed: Record<string, any>, headers: import('node:http').IncomingHttpHeaders, search: string }} request
 * @param {ForwardDeps & { timeouts: typeof TIMEOUTS, deadline: number, now: () => number, gone: AbortSignal }} deps
 */
async function attemptOne(res, attempt, request, deps) {
  const p = llmProvider(attempt.provider);
  if (!p) throw new Failed(`“${attempt.provider}” is not a provider MoPilot knows.`, 400);
  const name = `${p.label} (${attempt.model})`;
  const base = deps.bases[p.id] ?? (p.customBase ? attempt.baseUrl : p.baseUrl);
  const wire = p.wires.includes('anthropic') ? 'anthropic' : p.wires.includes('openai-chat') ? 'openai' : null;
  if (!wire || !base) throw new Failed(`${name}: MoPilot can't send Claude Code's requests to ${p.label} yet.`, 400);
  // a named provider's slot is its own; a server of the user's own is keyed by its address, which it has here
  const key = deps.keys.get(/** @type {string} */ (keySlotFor(p.id, attempt.baseUrl)));
  if (!key && !p.keyOptional)
    throw new Failed(`${name}: there is no key for ${p.label}. Add one in Settings → Accounts & billing → Providers & models.`, 400);
  const auth = key ? AUTH_HEADERS[p.auth](key) : {};
  const translate = deps.translate ?? llmRoute;
  const cfg = { provider: 'openai', model: attempt.model };
  /** @type {{ url: string, headers: Record<string, string>, body: Buffer, stream: boolean }} */
  let out;
  if (wire === 'openai') {
    const t = await translate.translateRequest('anthropic', request.body, /** @type {any} */ (cfg)).catch((error) => {
      throw new Failed(`${name}: ${clean(messageOf(error), null)}`, 400);
    });
    out = { url: `${base}${t.path}`, headers: { ...t.headers, ...auth }, body: t.body, stream: t.stream };
  } else {
    const h = request.headers;
    /** @type {Record<string, string>} */
    const beta = typeof h['anthropic-beta'] === 'string' ? { 'anthropic-beta': h['anthropic-beta'] } : {};
    out = {
      url: `${base}/v1/messages${request.search}`,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': String(h['anthropic-version'] ?? ANTHROPIC_VERSION),
        ...beta,
        ...auth,
      },
      body: Buffer.from(JSON.stringify({ ...request.parsed, model: attempt.model })),
      stream: request.parsed.stream === true,
    };
  }
  // a caller that left while its request was translated is sent nothing (and pays for nothing)
  if (deps.gone.aborted) throw new Failed(`${name}: the caller left.`, 499);
  // translating counts toward the deadline too
  if (deps.deadline - deps.now() <= 0) throw new Failed(`${name}: it took too long to answer.`, 504);
  // the deadline covers getting a reply under way; a started stream is held to the no-progress limit instead
  const upstream = new AbortController();
  const stop = () => upstream.abort();
  deps.gone.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, deps.deadline - deps.now());
  /** @type {import('node:http').IncomingMessage | null} */
  let u = null;
  try {
    u = await (deps.send ?? sendHttp)(out.url, { headers: out.headers, body: out.body, signal: upstream.signal }).catch((error) => {
      throw new Failed(
        `${name}: ${upstream.signal.aborted ? 'it took too long to answer' : clean(messageOf(error), key)}.`,
        upstream.signal.aborted ? 504 : 502,
      );
    });
    const status = /** @type {number} */ (u.statusCode);
    if (status < 200 || status >= 300) {
      const raw = await firstBytes(u, REFUSAL_MAX, deps.timeouts.refusal);
      throw new Failed(`${name} answered ${status}: ${refusalText(raw, key)}`, callerStatus(status));
    }
    if (!out.stream) {
      const raw = await readAll(u, REPLY_MAX).catch((error) => {
        throw new Failed(`${name}: its reply was cut off (${clean(messageOf(error), key)}).`, upstream.signal.aborted ? 504 : 502);
      });
      const reply =
        wire === 'openai'
          ? await translate.translateResponse('anthropic', raw, /** @type {any} */ (cfg)).catch((error) => {
              throw new Failed(`${name}: its reply couldn't be read (${clean(messageOf(error), key)}).`, 502);
            })
          : raw;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(reply);
      return;
    }
    const timedOut = () => upstream.signal.aborted && !deps.gone.aborted;
    await streamReply(res, u, { name, wire, cfg, translate, quiet: deps.timeouts.quiet, timer, gone: deps.gone, key, timedOut });
  } catch (error) {
    // a provider still sending (a refusal without end, a reply past its limit) is let go with the attempt
    u?.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    deps.gone.removeEventListener('abort', stop);
  }
}

/**
 * A streamed reply, translated as its bytes arrive. Nothing reaches the caller until the reply has said something, so a
 * provider that fails or goes quiet before that is one the next attempt may follow. Once started, a provider that goes
 * `quiet` ms without getting further (pings and keep-alive comments are not further), errors or drops ends the reply in
 * an error event the chat shows.
 * @param {import('node:http').ServerResponse} res @param {import('node:http').IncomingMessage} u
 * @param {{ name: string, wire: 'anthropic' | 'openai', cfg: any, translate: NonNullable<ForwardDeps['translate']>, quiet: number,
 *   timer: ReturnType<typeof setTimeout>, gone: AbortSignal, key: string | null, timedOut: () => boolean }} o `timedOut`: the deadline
 *   stopped the provider before the reply started
 */
function streamReply(res, u, { name, wire, cfg, translate, quiet, timer, gone, key, timedOut }) {
  const translator = wire === 'openai' ? new translate.StreamTranslator('anthropic', cfg) : null;
  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    /** what an Anthropic provider sent before its reply said anything (pings), sent with the first that does @type {Buffer[]} */
    let held = [];
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let idle;
    /** End the reply: done, or with why it failed (an error event once started; else a Failed the next attempt follows). @param {string | null} why @param {number} [status] */
    const end = (why, status = 502) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      gone.removeEventListener('abort', left);
      // nothing the provider sends after this reaches the caller
      u.removeAllListeners('data').removeAllListeners('end');
      u.destroy();
      if (why === null || gone.aborted) {
        translator?.close();
        return resolve(undefined);
      }
      if (!started) {
        translator?.close();
        return reject(new Failed(`${name}: ${why}`, status));
      }
      translator?.close();
      res.end(errorEvent(`${name}: ${why}`));
      reject(new Failed(why, status, true));
    };
    const left = () => end(null);
    /** The provider's stream ended early: cut by the deadline, or broken off. @param {string} why */
    const broke = (why) => (timedOut() ? end('it took too long to answer.', 504) : end(why));
    const wait = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => end(`it sent nothing further for ${Math.round(quiet / 1000)} seconds, so the reply was stopped.`, 504),
        quiet,
      );
    };
    // a caller that left before this: the attempt's abort already stopped the provider, whose close ends this
    gone.addEventListener('abort', left, { once: true });
    wait();
    u.on('data', (/** @type {Buffer} */ chunk) => {
      let bytes;
      try {
        bytes = translator ? translator.push(chunk) : chunk;
      } catch (error) {
        return end(`its stream couldn't be read (${clean(messageOf(error), key)}).`);
      }
      // before the reply starts, what was held is read with this chunk, so a ping cut in two is still a ping
      const further = translator ? bytes.length > 0 : !pingOnly(started ? chunk : Buffer.concat([...held, chunk]));
      if (further) wait();
      if (!bytes.length) return;
      if (!started) {
        if (!further) return void held.push(bytes);
        started = true;
        clearTimeout(timer);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        bytes = Buffer.concat([...held, bytes]);
        held = [];
      }
      res.write(bytes);
    });
    u.on('end', () => {
      let last;
      try {
        last = translator ? translator.finish() : Buffer.alloc(0);
      } catch (error) {
        return end(`its stream couldn't be finished (${clean(messageOf(error), key)}).`);
      }
      // a stream that said nothing before it ended is one the next attempt may follow, unless its last event, held for its
      // closing blank line, was the whole reply
      if (!started && !last.includes('event: message_start')) return end('its stream ended without a reply.');
      if (!started) {
        started = true;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      }
      settled = true;
      clearTimeout(idle);
      gone.removeEventListener('abort', left);
      res.end(last);
      resolve(undefined);
    });
    u.on('error', (error) => broke(`its stream broke off (${clean(messageOf(error), key)}).`));
    u.on('close', () => broke('its stream broke off.'));
  });
}

module.exports = { forward, pickModel, attemptsOf, pingOnly, errorBody, TIMEOUTS };
