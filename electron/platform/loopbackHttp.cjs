// The HTTP pieces the app's loopback proxies share (the Codex relay in electron/identity/accounts, the model router in
// electron/routing): hop-by-hop headers dropped, a body read whole, a compressed answer decoded, an upstream reply piped
// to the caller with either side's drop ending the other, a JSON refusal, and a child's environment that keeps loopback
// off the user's proxy.
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const { noteIgnored } = require('../ignored.cjs');

/** Headers that belong to one connection, not the request: a proxy never forwards them (content-length is recomputed). */
const HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'content-length',
]);

/** `h` without its hop-by-hop headers and empty values. @param {Record<string, unknown>} h */
function stripHop(h) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k) && v != null) out[k] = v;
  return out;
}

/**
 * Everything `stream` sends, in one buffer. With `limit`, it rejects (code `too_large`) once more than that many bytes came,
 * and keeps no more of them; the rest is read and dropped, so the caller can still answer on the same connection.
 * @param {NodeJS.ReadableStream} stream @param {number} [limit]
 * @returns {Promise<Buffer>}
 */
function readAll(stream, limit = Infinity) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    let parts = [];
    let size = 0;
    let ended = false;
    stream.on('data', (d) => {
      size += d.length;
      if (size <= limit) return void parts.push(d);
      parts = [];
      reject(Object.assign(new Error('The body is too large.'), { code: 'too_large' }));
    });
    stream.on('end', () => ((ended = true), resolve(Buffer.concat(parts))));
    stream.on('error', reject);
    // a body whose connection closed before it ended (a reply cut off)
    stream.on(
      'close',
      () => ended || reject(Object.assign(new Error('The connection closed before the body ended.'), { code: 'cut_off' })),
    );
  });
}

/** `buf` decoded by its content-encoding; bytes not compressed as labeled pass through. @param {Buffer} buf @param {unknown} enc */
function decode(buf, enc) {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
  } catch (error) {
    // not actually compressed as labeled: pass the bytes through unchanged
    noteIgnored(`decode a ${enc} answer`, error);
  }
  return buf;
}

/**
 * Streams an upstream response to the caller. Either side dropping ends the other, so a cut-off stream fails at once instead of idling out.
 * @param {import('node:http').IncomingMessage} u @param {import('node:http').ServerResponse} res
 */
function pipeTo(u, res) {
  pipeline(u, res, () => {
    /* pipeline destroys both streams on error; the abort handler below ends the other side */
  });
  u.on('aborted', () => res.destroy());
}

/**
 * Refuse with `{error:{message}}` JSON (or `body`, when given), or cut the connection once a reply has started.
 * @param {import('node:http').ServerResponse} res @param {number} status @param {string} message @param {unknown} [body]
 */
function fail(res, status, message, body) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: { message } }));
}

/**
 * A child's environment with loopback kept off any proxy the user's shell sets (NO_PROXY): a request to a loopback
 * proxy sent through a local proxy would come from that proxy, or not arrive.
 * @param {Record<string, string | undefined>} env
 */
function loopbackDirect(env) {
  const out = { ...env };
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const have = String(env[key] ?? env.NO_PROXY ?? env.no_proxy ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    out[key] = [...new Set([...have, '127.0.0.1', 'localhost'])].join(',');
  }
  return out;
}

module.exports = { HOP, stripHop, readAll, decode, pipeTo, fail, loopbackDirect };
