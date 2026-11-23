// The frames of the Host wire (docs: design/host/index.html, package 2.2a): one JSON line per control message, and a length-prefixed frame for binary payloads such as screenshots; the Host and the Mac app share this codec.

/** The largest frame, control line or binary, either end accepts; a peer that sends more is cut off. */
export const MAX_FRAME = 8 * 1024 * 1024;
/** The byte that starts a binary frame; a control line starts with `{`, so the two never collide. */
const BINARY = 0;

export class FrameError extends Error {
  /** @param {'too-large' | 'not-json' | 'not-object' | 'bad-binary'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

/** A control message: `JSON.stringify(message)` and a newline. @param {object} message */
export function encodeControl(message) {
  const line = Buffer.from(`${JSON.stringify(message)}\n`);
  if (line.length > MAX_FRAME) throw new FrameError('too-large', 'The message is larger than a frame.');
  return line;
}

/** A binary frame: `0x00`, the byte length of what follows (uint32), the JSON meta's length (uint32), the meta, then the bytes. @param {object} meta @param {Uint8Array} data */
export function encodeBinary(meta, data) {
  const metaBytes = Buffer.from(JSON.stringify(meta));
  const total = 4 + metaBytes.length + data.length;
  if (total > MAX_FRAME) throw new FrameError('too-large', 'The payload is larger than a frame.');
  const head = Buffer.alloc(9);
  head[0] = BINARY;
  head.writeUInt32BE(total, 1);
  head.writeUInt32BE(metaBytes.length, 5);
  return Buffer.concat([head, metaBytes, data]);
}

/**
 * @typedef {{ kind: 'control', message: Record<string, any> } | { kind: 'binary', meta: Record<string, any>, data: Buffer }} Frame
 */

/** @param {string} text @param {'not-json' | 'bad-binary'} code */
function parseObject(text, code) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameError(code, 'A frame is not JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new FrameError('not-object', 'A frame is not a JSON object.');
  return value;
}

/**
 * A decoder for one connection: `push` the bytes as they arrive and take the whole frames they complete. It throws a
 * FrameError on anything malformed or oversized (the caller drops the connection), and `pending` says how many bytes of
 * an unfinished frame are held, so a connection that ends with some left was truncated.
 * @param {{ maxFrame?: number }} [opts]
 */
export function createDecoder({ maxFrame = MAX_FRAME } = {}) {
  let buffer = Buffer.alloc(0);
  /** Chunks not yet joined to `buffer`: a large frame arriving in small pieces is joined once, not once per piece. @type {Buffer[]} */
  let queued = [];
  let queuedSize = 0;
  /** The bytes a binary frame needs before it can be read, once its header said so. */
  let need = 0;
  return {
    /** @param {Uint8Array | string} chunk @returns {Frame[]} */
    push(chunk) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (piece.length === 0) return [];
      queued.push(piece);
      queuedSize += piece.length;
      const held = buffer.length + queuedSize;
      if (held < need) return [];
      const head = buffer.length > 0 ? buffer[0] : queued[0][0];
      if (head !== BINARY && piece.indexOf(10) < 0) {
        if (held > maxFrame) throw new FrameError('too-large', 'A line is longer than allowed.');
        return [];
      }
      buffer = Buffer.concat([buffer, ...queued]);
      queued = [];
      queuedSize = 0;
      /** @type {Frame[]} */
      const out = [];
      for (need = 0; buffer.length > 0; need = 0) {
        if (buffer[0] === BINARY) {
          if (buffer.length < 9) break;
          const total = buffer.readUInt32BE(1);
          if (total > maxFrame) throw new FrameError('too-large', 'A frame is larger than allowed.');
          const metaLength = buffer.readUInt32BE(5);
          if (total < 4 || metaLength > total - 4) throw new FrameError('bad-binary', 'A binary frame has a bad length.');
          if (buffer.length < 5 + total) {
            need = 5 + total;
            break;
          }
          const meta = parseObject(buffer.subarray(9, 9 + metaLength).toString('utf8'), 'bad-binary');
          out.push({ kind: 'binary', meta, data: Buffer.from(buffer.subarray(9 + metaLength, 5 + total)) });
          buffer = buffer.subarray(5 + total);
          continue;
        }
        const end = buffer.indexOf(10);
        if (end < 0) {
          if (buffer.length > maxFrame) throw new FrameError('too-large', 'A line is longer than allowed.');
          break;
        }
        if (end > maxFrame) throw new FrameError('too-large', 'A line is longer than allowed.');
        const message = parseObject(buffer.subarray(0, end).toString('utf8'), 'not-json');
        out.push({ kind: 'control', message });
        buffer = buffer.subarray(end + 1);
      }
      return out;
    },
    /** Bytes held of a frame that has not finished. */
    pending: () => buffer.length + queuedSize,
  };
}
