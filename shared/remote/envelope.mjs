// The wire shapes of Mobile Remote that carry no secret: base64 and hex over plain Uint8Array (no Buffer, so the phone runs the same file), the sealed frame the relay routes ({ pair, dir, ctr, nonce, box }, at most 256 KB), the authenticated header, and the hello / hello-reply frames of pairing.

export const MAX_FRAME_BYTES = 256 * 1024;
export const DIRS = Object.freeze(['p2m', 'm2p']);
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class EnvelopeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/** @param {string} text standard base64 with padding; anything else throws */
export function fromBase64(text) {
  if (typeof text !== 'string' || !B64_RE.test(text)) throw new EnvelopeError('base64', 'not base64');
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) n = (n << 6) | (text[i + j] === '=' ? 0 : B64.indexOf(text[i + j]));
    for (const shift of [16, 8, 0]) if (o < out.length) out[o++] = (n >> shift) & 255;
  }
  return out;
}

/** @param {Uint8Array} bytes */
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {string} text an even number of hex digits */
export function fromHex(text) {
  if (typeof text !== 'string' || text.length % 2 || !/^[0-9a-f]*$/.test(text)) throw new EnvelopeError('hex', 'not hex');
  return Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

export const utf8 = (/** @type {string} */ s) => enc.encode(s);
export const fromUtf8 = (/** @type {Uint8Array} */ b) => dec.decode(b);

/** The header the box authenticates and the relay reads. @param {string} pair @param {string} dir @param {number} ctr */
export const headerAad = (pair, dir, ctr) => utf8(`mopilot-remote-v1|${pair}|${dir}|${ctr}`);

/**
 * A frame as the relay carries it, checked field by field; the box and nonce are base64 here and bytes after
 * decodeFrame.
 * @param {unknown} f
 * @returns {{ pair: string, dir: 'p2m' | 'm2p', ctr: number, nonce: string, box: string }}
 */
export function checkFrame(f) {
  const x = /** @type {any} */ (f);
  if (!x || typeof x !== 'object') throw new EnvelopeError('frame', 'a frame is an object');
  if (typeof x.pair !== 'string' || !/^p_[A-Za-z0-9_-]{8,64}$/.test(x.pair)) throw new EnvelopeError('frame', 'bad pair id');
  if (!DIRS.includes(x.dir)) throw new EnvelopeError('frame', 'bad direction');
  if (!Number.isSafeInteger(x.ctr) || x.ctr < 0) throw new EnvelopeError('frame', 'bad counter');
  if (typeof x.nonce !== 'string' || typeof x.box !== 'string') throw new EnvelopeError('frame', 'nonce and box are strings');
  if (x.nonce.length + x.box.length + 128 > MAX_FRAME_BYTES * 1.4) throw new EnvelopeError('size', 'frame too large');
  return { pair: x.pair, dir: x.dir, ctr: x.ctr, nonce: x.nonce, box: x.box };
}

/** The frame as the relay carries it (base64 strings), refused when the box is over the relay's cap. @param {{ pair: string, dir: string, ctr: number, nonce: Uint8Array, box: Uint8Array }} f */
export function toWire(f) {
  if (f.box.length > MAX_FRAME_BYTES) throw new EnvelopeError('size', 'frame over 256 KB');
  return { pair: f.pair, dir: f.dir, ctr: f.ctr, nonce: toBase64(f.nonce), box: toBase64(f.box) };
}

/** The serialized frame. @param {Parameters<typeof toWire>[0]} f */
export const encodeFrame = (f) => JSON.stringify(toWire(f));

/** @param {string | object} text a serialized frame or the parsed one */
export function decodeFrame(text) {
  let parsed = text;
  if (typeof text === 'string') {
    if (text.length > MAX_FRAME_BYTES * 2) throw new EnvelopeError('size', 'frame too large');
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new EnvelopeError('frame', 'not JSON');
    }
  }
  const f = checkFrame(parsed);
  return { pair: f.pair, dir: f.dir, ctr: f.ctr, nonce: fromBase64(f.nonce), box: fromBase64(f.box) };
}

const KINDS = ['request', 'reply', 'event', 'ack'];

/**
 * The sealed message after decryption, checked for what every kind shares; a method's params are the service's to validate.
 * @param {unknown} m
 */
export function checkMessage(m) {
  const x = /** @type {any} */ (m);
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new EnvelopeError('message', 'a message is an object');
  if (typeof x.id !== 'string' || !x.id || x.id.length > 64) throw new EnvelopeError('message', 'bad id');
  if (!Number.isFinite(x.t)) throw new EnvelopeError('message', 'bad time');
  if (!KINDS.includes(x.kind)) throw new EnvelopeError('message', 'bad kind');
  if (x.kind === 'request' && (typeof x.method !== 'string' || !x.method)) throw new EnvelopeError('message', 'a request names its method');
  if ((x.kind === 'reply' || x.kind === 'ack') && typeof x.inReplyTo !== 'string')
    throw new EnvelopeError('message', 'a reply names its request');
  return x;
}

/** @param {object} m */
export const encodeMessage = (m) => utf8(JSON.stringify(m));

/** @param {Uint8Array} bytes */
export function decodeMessage(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new EnvelopeError('message', 'not JSON');
  }
  return checkMessage(parsed);
}
