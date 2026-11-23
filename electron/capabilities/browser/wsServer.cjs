// The server end of a WebSocket (RFC 6455) on an HTTP upgrade, for the Chrome relay (chromeRelay.cjs): text messages, ping, close.
//
// Small on purpose: the relay's one peer is the Playwright Extension on loopback, which sends masked text
// frames. Binary frames and unmasked client frames close the connection (1003, 1002); a message over
// `maxBytes` closes it with 1009. Server frames are never masked.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ByteQueue } = require('../../transport/byteQueue.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BYTES = 64 * 1024 * 1024;

/** The Sec-WebSocket-Accept value for a client's key. */
function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(String(key) + GUID)
    .digest('base64');
}

/**
 * One frame, unmasked (the server's own): FIN set, `opcode`, and the payload.
 * @param {number} opcode
 * @param {Buffer} payload
 */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** A protocol error, with the close code to send. */
class WsProtocolError extends Error {
  /** @param {number} code @param {string} reason */
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

/**
 * Splits the client's byte stream into frames. Throws WsProtocolError for a protocol error.
 * @param {number} maxBytes
 */
class FrameParser {
  constructor(maxBytes = MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.bytes = new ByteQueue();
  }

  /** @returns {{ fin: boolean, opcode: number, payload: Buffer }[]} */
  push(chunk) {
    this.bytes.push(chunk);
    const out = [];
    for (;;) {
      if (this.bytes.length < 2) break;
      const head = this.bytes.peek(Math.min(this.bytes.length, 14));
      const b0 = head[0];
      const b1 = head[1];
      if (!(b1 & 0x80)) throw new WsProtocolError(1002, 'unmasked client frame');
      let len = b1 & 0x7f;
      let at = 2;
      if (len === 126) {
        if (this.bytes.length < 4) break;
        len = head.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (this.bytes.length < 10) break;
        const big = head.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) throw new WsProtocolError(1009, 'message too big');
        len = Number(big);
        at = 10;
      }
      if (len > this.maxBytes) throw new WsProtocolError(1009, 'message too big');
      if (this.bytes.length < at + 4 + len) break;
      this.bytes.discard(at);
      const mask = this.bytes.take(4);
      const payload = Buffer.from(this.bytes.take(len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      out.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload });
    }
    return out;
  }
}

/** An open WebSocket: emits 'message' (text) and 'close' (code, reason) once. */
class WsConnection extends EventEmitter {
  /** @param {import('node:net').Socket} socket @param {{ maxBytes?: number }} [o] */
  constructor(socket, { maxBytes = MAX_BYTES } = {}) {
    super();
    this.socket = socket;
    this.maxBytes = maxBytes;
    this.parser = new FrameParser(maxBytes);
    /** the fragments of a text message still arriving */
    this.parts = null;
    this.size = 0;
    this.closed = false;
    socket.on('data', (chunk) => this.#data(chunk));
    // the HTTP server's sockets are half-open: the peer ending its side is the end of the connection
    socket.on('end', () => {
      socket.end();
      this.#gone(1006, 'connection lost');
    });
    socket.on('close', () => this.#gone(1006, 'connection lost'));
    socket.on('error', (error) => noteIgnored('read from the Chrome relay socket', error));
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  /**
   * The largest message from now on: a connection may take only small messages until its peer proved who it is.
   * @param {number} maxBytes
   */
  setMaxBytes(maxBytes) {
    this.maxBytes = maxBytes;
    this.parser.maxBytes = maxBytes;
  }

  #data(chunk) {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (e) {
      return this.close(/** @type {WsProtocolError} */ (e).code, /** @type {WsProtocolError} */ (e).message);
    }
    for (const f of frames) {
      if (this.closed) return;
      this.#frame(f);
    }
  }

  #frame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      return this.close(code === 1005 ? 1000 : code, reason);
    }
    if (opcode === 0x9) return this.#write(0xa, payload);
    if (opcode === 0xa) return;
    if (opcode === 0x2) return this.close(1003, 'binary messages are not supported');
    if (opcode === 0x1) {
      if (this.parts) return this.close(1002, 'a new message inside a fragmented one');
      this.parts = [];
      this.size = 0;
    } else if (opcode !== 0x0 || !this.parts) return this.close(1002, 'unexpected frame');
    this.size += payload.length;
    if (this.size > this.maxBytes) return this.close(1009, 'message too big');
    this.parts.push(payload);
    if (!fin) return;
    const text = Buffer.concat(this.parts).toString('utf8');
    this.parts = null;
    this.emit('message', text);
  }

  #write(opcode, payload) {
    if (!this.open) return false;
    this.socket.write(encodeFrame(opcode, payload));
    return true;
  }

  /** Sends a text message; false when the connection is closed. */
  send(text) {
    return this.#write(0x1, Buffer.from(String(text), 'utf8'));
  }

  /** Closes with a close frame, then ends the socket. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const why = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const body = Buffer.alloc(2 + why.length);
    body.writeUInt16BE(code, 0);
    why.copy(body, 2);
    this.#write(0x8, body);
    this.socket.end();
    this.#gone(code, String(reason));
  }

  #gone(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}

/**
 * Completes the upgrade of an HTTP request to a WebSocket and returns the connection, or null after
 * answering 400 for a request that is not a WebSocket handshake.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head bytes that arrived with the request
 * @param {{ maxBytes?: number }} [o]
 */
function acceptWebSocket(req, socket, head, o = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const ws = new WsConnection(socket, o);
  if (head && head.length) socket.emit('data', head);
  return ws;
}

module.exports = { acceptWebSocket, acceptKey, encodeFrame, FrameParser, WsConnection, WsProtocolError, MAX_BYTES };
