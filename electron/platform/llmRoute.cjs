// The model router's translation in the Rust core (core/crates/llmroute): a request in the wire its SDK speaks as a
// provider's, and the provider's reply, whole or streamed, back in that wire. The core does the work; this frames the
// calls, so a body crosses as bytes and is never escaped into a string. Keys and HTTP stay with the router.
const { core, requiredCore } = require('./core.cjs');

/** @typedef {import('./core.cjs').CoreAddon} CoreAddon */
/**
 * A routing config as translation reads it; the router's other fields (its id, base URL, fallbacks) may ride along.
 * @typedef {{ provider: 'openai', model: string, maxTokens?: number, temperature?: number, cacheKey?: string, strictMedia?: boolean, refuseDocumentUrls?: boolean }} RouteConfig
 */
/** The wires a caller may speak. @typedef {'anthropic'} Inbound */

const NEWLINE = 0x0a;

/** A line of JSON, then `bytes` as they are. @param {unknown} header @param {Buffer | string} bytes */
const framed = (header, bytes) => Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), Buffer.from(bytes)]);

/**
 * The provider's request for `body`, a request in wire `inbound`, under `config`: its path under the provider's base
 * URL, its headers, whether it streams, the model it goes to, and its body. It rejects with what could not be
 * translated, which is the request's fault.
 * @param {Inbound} inbound @param {Buffer | string} body @param {RouteConfig} config @param {CoreAddon | null} [addon]
 * @returns {Promise<{ path: string, headers: Record<string, string>, stream: boolean, model: string, body: Buffer }>}
 */
async function translateRequest(inbound, body, config, addon = core()) {
  const reply = await requiredCore(addon).dispatch('llmroute.translateRequest', framed({ inbound, config }, body));
  const at = reply.indexOf(NEWLINE);
  return { ...JSON.parse(reply.subarray(0, at).toString()), body: reply.subarray(at + 1) };
}

/**
 * The caller's reply for the provider's whole reply `body`. It rejects with what could not be read, which is the
 * provider's fault.
 * @param {Inbound} inbound @param {Buffer | string} body @param {RouteConfig} config @param {CoreAddon | null} [addon]
 * @returns {Promise<Buffer>}
 */
async function translateResponse(inbound, body, config, addon = core()) {
  return requiredCore(addon).dispatch('llmroute.translateResponse', framed({ inbound, config }, body));
}

/**
 * One streamed reply's translation, held by the core: `push` the provider's bytes as they arrive, cut anywhere, and
 * send on what it returns; `finish` once the provider's stream ends, or `close` to give the reply up part way. A stream
 * that ends before the provider says it is done finishes in an error event, never a reply that looks complete.
 */
class StreamTranslator {
  /** @param {Inbound} inbound @param {RouteConfig} config @param {CoreAddon | null} [addon] */
  constructor(inbound, config, addon = core()) {
    this.addon = requiredCore(addon);
    this.id = String(this.addon.dispatchSync('llmroute.streamOpen', Buffer.from(JSON.stringify({ inbound, config }))));
    /** whether the core still holds it */
    this.open = true;
  }

  /** The caller's bytes for the provider's next `bytes`: empty until an event completes. @param {Buffer | string} bytes */
  push(bytes) {
    return this.addon.dispatchSync('llmroute.streamPush', Buffer.concat([Buffer.from(`${this.id}\n`), Buffer.from(bytes)]));
  }

  /** The caller's last bytes; the core lets the translator go. */
  finish() {
    this.open = false;
    return this.addon.dispatchSync('llmroute.streamFinish', Buffer.from(this.id));
  }

  /** Let the translator go without its end, for a reply given up part way; again, or after `finish`, does nothing. */
  close() {
    if (!this.open) return;
    this.open = false;
    this.addon.dispatchSync('llmroute.streamClose', Buffer.from(this.id));
  }
}

module.exports = { translateRequest, translateResponse, StreamTranslator };
