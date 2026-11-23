// One authenticated socket as the hub tracks it, and the flow control around it: messages are handled one at a time in
// arrival order, so a burst is held back by pausing the socket (TCP slows the sender) instead of cutting the connection, and
// a receiver that stops reading is dropped rather than allowed to hold memory or its sender's queue.

/**
 * @typedef {{ send(text: string, cb: (err?: Error | null) => void): void, close(code: number, reason: string): void, ping(): void, terminate(): void, pause?(): void, resume?(): void, bufferedAmount?: number }} Socket
 * @typedef {{ userId: string, deviceId: string, kind: 'desktop' | 'phone' | 'host' | 'hostlink', expMs: number, iatMs?: number, baseDeviceId?: string, ip?: string }} Identity
 */

/** A receipt is a few bytes and owed once per delivered frame, so a receiver coming back to a backlog sends hundreds at once: the receipts waiting are counted apart, up to what a mailbox can hold. */
export const isReceipt = (/** @type {string} */ raw) => {
  if (raw.length >= 512 || !raw.includes('"ack"')) return false;
  try {
    return JSON.parse(raw)?.t === 'ack';
  } catch {
    return false;
  }
};

export class Conn {
  constructor(/** @type {Socket} */ socket, /** @type {Identity} */ identity) {
    this.socket = socket;
    this.identity = identity;
    this.missed = 0;
    this.draining = false;
    this.dirty = false;
    /** whether a delivery asked for while one was running wants the plain mailbox read in full */
    this.fullPending = false;
    /** @type {Map<string, number>} the highest durable counter sent on this connection per pair and direction; a new connection starts over, which is the redelivery */
    this.sent = new Map();
    this.closed = false;
    /** set the moment the transport reports the socket closed, before the close is handled behind the messages still queued */
    this.gone = false;
    this.pending = 0;
    /** receipts waiting behind the message being handled (counted apart from `pending`) */
    this.receipts = 0;
    /** text bytes of the messages waiting */
    this.bytes = 0;
    /** whether the socket is paused because too many messages are waiting */
    this.paused = false;
    this.queue = Promise.resolve();
    /** @type {Set<Promise<void>>} background deliveries to this connection that have not finished */
    this.kicks = new Set();
  }

  get waiting() {
    return this.pending + this.receipts;
  }
}

/**
 * Counts a message in. Returns false when the connection is past its hard cap (the caller cuts it off); otherwise pauses the
 * socket once enough messages are waiting. `force` counts it in regardless: the relay's own start-up and close handling run
 * on the same queue and must be counted so that releasing them balances.
 * @param {Conn} conn @param {boolean} receipt @param {number} bytes @param {import('./limits.mjs').Limits} limits @param {number} maxReceipts @param {boolean} [force]
 */
export function admit(conn, receipt, bytes, limits, maxReceipts, force = false) {
  const full = receipt ? conn.receipts >= maxReceipts : conn.pending >= limits.pendingMax;
  if (!force && (full || conn.bytes + bytes > limits.pendingBytesMax)) return false;
  if (receipt) conn.receipts++;
  else conn.pending++;
  conn.bytes += bytes;
  if (!conn.paused && conn.waiting >= limits.pendingHigh) {
    conn.paused = true;
    conn.socket.pause?.();
  }
  return true;
}

/** Counts a handled message out and resumes a paused socket once the backlog is down. */
export function release(
  /** @type {Conn} */ conn,
  /** @type {boolean} */ receipt,
  /** @type {number} */ bytes,
  /** @type {import('./limits.mjs').Limits} */ limits,
) {
  if (receipt) conn.receipts--;
  else conn.pending--;
  conn.bytes -= bytes;
  if (conn.paused && conn.waiting <= limits.pendingLow) {
    conn.paused = false;
    if (!conn.closed) conn.socket.resume?.();
  }
}

/**
 * Sends one text and says whether the socket took it. A socket with too many unsent bytes, or one whose send does not finish
 * in time, is a slow consumer: `onSlow` drops it and the send reports false.
 * @param {Conn} conn @param {string} text @param {import('./limits.mjs').Limits} limits @param {(conn: Conn) => void} onSlow
 * @returns {Promise<boolean>}
 */
export function sendText(conn, text, limits, onSlow) {
  if (conn.closed) return Promise.resolve(false);
  if ((conn.socket.bufferedAmount ?? 0) > limits.slowConsumerBytes) {
    onSlow(conn);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (/** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      onSlow(conn);
      finish(false);
    }, limits.sendTimeoutMs);
    timer.unref();
    try {
      conn.socket.send(text, (err) => finish(!err));
    } catch {
      finish(false);
    }
  });
}
