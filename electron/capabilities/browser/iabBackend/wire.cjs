// Native-endian browser frames and the gated JSON-RPC socket peer.
const os = require('node:os');
const { ByteQueue } = require('../../../transport/byteQueue.cjs');
const { noteIgnored, messageOf } = require('../../../ignored.cjs');
const { MAX_IN, MAX_OUT, fail } = require('./protocol.cjs');
/** The host's byte order ('LE' or 'BE'): frame lengths are native endian. */
const ENDIAN = os.endianness();

/** A message as one frame: u32 length (native endian) and its JSON. */
function encodeFrame(message, max = MAX_OUT) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > max) throw fail('The message is too large for the browser pipe.');
  const out = Buffer.allocUnsafe(4 + body.length);
  out[`writeUInt32${ENDIAN}`](body.length, 0);
  body.copy(out, 4);
  return out;
}

/** Splits a byte stream into frames; throws on a frame over `max`. */
class FrameDecoder {
  constructor(max = MAX_IN) {
    this.max = max;
    this.bytes = new ByteQueue();
  }
  push(chunk) {
    this.bytes.push(chunk);
    const out = [];
    while (this.bytes.length >= 4) {
      const len = this.bytes.peek(4)[`readUInt32${ENDIAN}`](0);
      if (len > this.max) throw fail('frame too large');
      if (this.bytes.length < 4 + len) break;
      this.bytes.discard(4);
      out.push(JSON.parse(this.bytes.take(len).toString('utf8')));
    }
    return out;
  }
}
/**
 * One accepted connection: JSON-RPC 2.0 over frames. Nothing is handled until `gate` resolves true; on
 * false (or a bad frame) the socket goes.
 */
class Peer {
  /** @param {any} socket @param {(method: string, params: any) => Promise<any>} handle @param {Promise<boolean>} gate */
  constructor(socket, handle, gate) {
    this.socket = socket;
    this.handle = handle;
    this.closed = false;
    const decoder = new FrameDecoder();
    let chain = gate.then(
      (ok) => {
        if (!ok) socket.destroy();
        return ok;
      },
      () => {
        socket.destroy();
        return false;
      },
    );
    socket.on('data', (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch {
        return socket.destroy();
      }
      for (const m of messages)
        chain = chain.then((ok) => {
          if (ok) void this.#message(m);
          return ok;
        });
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      /* the close handler deals with a lost socket */
    });
  }

  /** `answer`: whether an answer that cannot be sent is replaced by a short error answer (once). */
  send(message, answer = true) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(message));
    } catch (error) {
      // an answer too large for the pipe: the request gets the error now rather than timing out
      if (answer && message.id !== undefined)
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: 1, message: messageOf(error).slice(0, 1000) } }, false);
      else noteIgnored('send a message to the Codex browser plugin', error);
    }
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async #message(m) {
    if (!m || typeof m.method !== 'string') return;
    // a notification (moveMouse): handled, never answered
    if (m.id === undefined)
      return void this.handle(m.method, m.params).catch((error) =>
        noteIgnored(`handle the browser plugin's ${m.method} notification`, error),
      );
    try {
      this.send({ jsonrpc: '2.0', id: m.id, result: (await this.handle(m.method, m.params)) ?? null });
    } catch (e) {
      /** @type {any} */
      const r = e;
      // a refusal also carries its reason, whether retrying helps and the next step as data (refusals.cjs)
      const data = r?.refusal ? { reason: r.reason, retryable: r.retryable, next: r.next, browser: r.browser } : undefined;
      this.send({
        jsonrpc: '2.0',
        id: m.id,
        error: { code: 1, message: e instanceof Error ? e.message : String(e), ...(data ? { data } : {}) },
      });
    }
  }
}

module.exports = { encodeFrame, FrameDecoder, Peer };
