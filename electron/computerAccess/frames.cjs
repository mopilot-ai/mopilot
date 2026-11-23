// Computer access (#1364): the encrypted frames of a connection once its handshake is done.
//
// A frame is base64url(counter (8 bytes) | AES-256-GCM ciphertext | tag (16 bytes)), sent as a WebSocket text
// message. Each direction has its own key and its own counter, starting at 0 and going up by one per frame; the
// counter is the GCM nonce and the additional data. A frame whose counter is not the next one (repeated, skipped,
// reordered) or that does not decrypt ends the connection: nothing of an earlier frame or connection can be replayed.
const crypto = require('node:crypto');

/** The largest plaintext a frame carries (a full-size screenshot fits). */
const FRAME_MAX = 16 * 1024 * 1024;

class FrameError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const nonceOf = (counter) => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(counter, 4);
  return n;
};

class SecureChannel {
  /** @param {{ send: Buffer, recv: Buffer }} session the keys the handshake derived */
  constructor(session) {
    if (!Buffer.isBuffer(session?.send) || session.send.length !== 32 || !Buffer.isBuffer(session?.recv) || session.recv.length !== 32)
      throw new FrameError('keys', 'A secure channel needs two 32-byte keys');
    this.sendKey = session.send;
    this.recvKey = session.recv;
    this.sent = 0n;
    this.received = 0n;
  }

  /**
   * The frame for `message` (any JSON value).
   * @param {unknown} message
   */
  seal(message) {
    const plain = Buffer.from(JSON.stringify(message), 'utf8');
    if (plain.length > FRAME_MAX) throw new FrameError('too_large', 'A message is too large to send');
    const counter = this.sent;
    this.sent += 1n;
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(counter);
    const c = crypto.createCipheriv('aes-256-gcm', this.sendKey, nonceOf(counter));
    c.setAAD(head);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([head, body, c.getAuthTag()]).toString('base64url');
  }

  /**
   * The message in `frame`; throws a FrameError when it is not the next frame of this connection.
   * @param {unknown} frame
   */
  open(frame) {
    if (typeof frame !== 'string') throw new FrameError('malformed', 'Not a frame');
    // base64url grows by 4/3: anything longer than the largest frame is refused before it is read at all
    if (frame.length > Math.ceil(((FRAME_MAX + 24) * 4) / 3) + 4) throw new FrameError('too_large', 'A frame is too large');
    if (!/^[A-Za-z0-9_-]+$/.test(frame)) throw new FrameError('malformed', 'Not a frame');
    const raw = Buffer.from(frame, 'base64url');
    if (raw.length < 24) throw new FrameError('malformed', 'A frame is too short');
    const head = raw.subarray(0, 8);
    const counter = head.readBigUInt64BE();
    if (counter !== this.received) throw new FrameError('replay', 'A frame came out of order or twice');
    const d = crypto.createDecipheriv('aes-256-gcm', this.recvKey, nonceOf(counter));
    d.setAAD(head);
    d.setAuthTag(raw.subarray(raw.length - 16));
    let plain;
    try {
      plain = Buffer.concat([d.update(raw.subarray(8, raw.length - 16)), d.final()]);
    } catch {
      throw new FrameError('unauthorized', 'A frame did not decrypt');
    }
    this.received += 1n;
    try {
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw new FrameError('malformed', 'A frame is not JSON');
    }
  }
}

module.exports = { SecureChannel, FrameError, FRAME_MAX };
