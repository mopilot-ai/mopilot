// Remote terminals: one shell per stream in a followed chat's folder, its output sealed to the phone as a byte stream with a 2 MB high-water mark and a short replay window for a reconnect.
const { RemoteError } = require('./serviceErrors.cjs');
const { assertMirror, stillAllowed } = require('./mirrorGuard.cjs');

/** Unacknowledged bytes at which the shell stops being read, and below which it resumes: electron/transport/jsonReader.cjs's marks. */
const HIGH_BYTES = 2 * 1024 * 1024;
const LOW_BYTES = 512 * 1024;
/** Output a reconnecting phone can still replay, in bytes. */
const RING_BYTES = 256 * 1024;
/** One pty.data event carries at most this much, well under a sealed frame. */
const SLICE_BYTES = 32 * 1024;
/** Terminals one device keeps open at once. */
const MAX_PER_PAIR = 4;

const keyOf = (/** @type {string} */ pairId, /** @type {string} */ stream) => `remote:${pairId}:${stream}`;

class PtyMirror {
  /** @param {any} svc the RemoteService */
  constructor(svc) {
    this.svc = svc;
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    /** @type {Set<string>} streams being opened (an approval card may be up) */
    this.opening = new Set();
    /** @type {Map<string, { card: AbortController, client: any, chatId: string }>} the approval card each opening stream has up */
    this.cards = new Map();
    /** @type {Set<string>} pair, chat and folder the Mac already approved a terminal for */
    this.approved = new Set();
  }

  get #pty() {
    return this.svc.ops.mirror.pty;
  }

  /** Opens a shell in the chat's folder, or resumes the stream a reconnecting phone names. */
  async open(/** @type {any} */ client, /** @type {any} */ p) {
    assertMirror(this.svc, client, p.chatId);
    const key = keyOf(client.pairId, p.stream);
    const live = this.sessions.get(key);
    if (live) {
      if (live.chatId !== p.chatId) throw new RemoteError('stale', 'That terminal belongs to another chat.');
      return this.#resume(live, p.from);
    }
    if (this.opening.has(key)) throw new RemoteError('stale', 'That terminal is already opening.');
    if ([...this.sessions.values()].filter((s) => s.client.pairId === client.pairId).length >= MAX_PER_PAIR)
      throw new RemoteError('forbidden', 'Close a terminal before opening another.');
    this.opening.add(key);
    // the card goes away with the device: a revoked pair or a stopped service retires it
    const card = new AbortController();
    this.cards.set(key, { card, client, chatId: p.chatId });
    try {
      const cwd = await this.svc.ops.mirror.folderOf(p.chatId);
      if (!cwd) throw new RemoteError('gone', this.svc.goneText);
      const grant = `${client.pairId}\0${p.chatId}\0${cwd}`;
      if (!this.approved.has(grant)) {
        if (!(await this.svc.ops.mirror.approveTerminal(p.chatId, { cwd, pairId: client.pairId, signal: card.signal })))
          throw new RemoteError('forbidden', 'This Mac declined the terminal.');
        this.approved.add(grant);
      }
      // the approval card was up: the device may have left, been turned off or stopped following the chat
      assertMirror(this.svc, client, p.chatId);
      this.svc.assertPaired(client);
      return this.#spawn(client, p, key, cwd);
    } finally {
      this.opening.delete(key);
      this.cards.delete(key);
    }
  }

  #spawn(/** @type {any} */ client, /** @type {any} */ p, /** @type {string} */ key, /** @type {string} */ cwd) {
    /** @type {any} */
    const s = {
      key,
      client,
      chatId: p.chatId,
      stream: p.stream,
      ring: Buffer.alloc(0),
      start: 0,
      at: 0,
      inflight: 0,
      paused: false,
      tail: Promise.resolve(),
    };
    this.sessions.set(key, s);
    try {
      this.#pty.spawn(
        key,
        // the phone's terminal is a text view that answers no terminal queries, ConPTY's start-up question among them (pty.cjs)
        { cwd, cols: p.cols, rows: p.rows, selfAnswer: true },
        {
          onData: (/** @type {string} */ d) => this.#output(s, Buffer.from(d, 'utf8')),
          onExit: ({ exitCode, signal, killed }) => {
            if (killed || this.sessions.get(key) !== s) return;
            this.sessions.delete(key);
            void this.#emit(s, { ev: 'pty.exit', stream: s.stream, at: s.at, exitCode, signal });
          },
        },
      );
    } catch (error) {
      this.sessions.delete(key);
      throw error;
    }
    return { stream: p.stream, resumed: false, at: 0, truncated: false };
  }

  #resume(/** @type {any} */ s, /** @type {number | undefined} */ from) {
    const want = Math.min(from ?? s.start, s.at);
    const begin = Math.max(want, s.start);
    this.#slices(s, s.ring.subarray(begin - s.start), begin);
    return { stream: s.stream, resumed: true, at: s.at, truncated: want < s.start };
  }

  #output(/** @type {any} */ s, /** @type {Buffer} */ bytes) {
    // output that was already on its way when the shell ended
    if (this.sessions.get(s.key) !== s) return;
    if (!stillAllowed(this.svc, s.client, s.chatId)) return void this.#end(s);
    const begin = s.at;
    s.at += bytes.length;
    s.ring = Buffer.concat([s.ring, bytes]);
    if (s.ring.length > RING_BYTES) {
      s.start += s.ring.length - RING_BYTES;
      s.ring = s.ring.subarray(s.ring.length - RING_BYTES);
    }
    this.#slices(s, bytes, begin);
  }

  /** Sends `bytes` (which start at stream offset `begin`) in slices; reading stops while too much is unacknowledged. */
  #slices(/** @type {any} */ s, /** @type {Buffer} */ bytes, /** @type {number} */ begin) {
    for (let i = 0; i < bytes.length; i += SLICE_BYTES) {
      const slice = bytes.subarray(i, i + SLICE_BYTES);
      s.inflight += slice.length;
      const sent = this.#emit(s, { ev: 'pty.data', stream: s.stream, at: begin + i, data: slice.toString('base64') });
      void sent.then(() => {
        s.inflight -= slice.length;
        if (s.paused && s.inflight <= LOW_BYTES && this.sessions.get(s.key) === s) {
          s.paused = false;
          this.#pty.resume(s.key);
        }
      });
    }
    if (!s.paused && s.inflight >= HIGH_BYTES) {
      s.paused = true;
      this.#pty.pause(s.key);
    }
  }

  /** One event in order after the stream's earlier ones; never rejects. */
  #emit(/** @type {any} */ s, /** @type {object} */ event) {
    const next = s.tail
      .then(() => this.svc.emit(s.client.pairId, event))
      .catch((error) => this.svc.note('send a terminal event to a paired phone', error));
    s.tail = next;
    return next;
  }

  #session(/** @type {any} */ client, /** @type {string} */ stream) {
    const s = this.sessions.get(keyOf(client.pairId, stream));
    if (!s) throw new RemoteError('gone', "That terminal isn't open.");
    if (!stillAllowed(this.svc, client, s.chatId)) {
      this.#end(s);
      throw new RemoteError('forbidden', 'Mirroring is off for this chat on this device.');
    }
    return s;
  }

  write(/** @type {any} */ client, /** @type {any} */ p) {
    const s = this.#session(client, p.stream);
    this.#pty.write(s.key, p.data);
    return { written: true };
  }

  resize(/** @type {any} */ client, /** @type {any} */ p) {
    const s = this.#session(client, p.stream);
    this.#pty.resize(s.key, p.cols, p.rows);
    return { resized: true };
  }

  close(/** @type {any} */ client, /** @type {any} */ p) {
    const s = this.sessions.get(keyOf(client.pairId, p.stream));
    if (s) this.#end(s);
    return { closed: true };
  }

  #end(/** @type {any} */ s) {
    this.sessions.delete(s.key);
    this.#pty.kill(s.key);
  }

  /** A device left or this Mac stopped serving: its shells end and its approvals are forgotten. */
  dropPair(/** @type {string} */ pairId) {
    for (const s of [...this.sessions.values()]) if (s.client.pairId === pairId) this.#end(s);
    for (const [key, up] of this.cards) if (key.startsWith(`remote:${pairId}:`)) up.card.abort();
    for (const g of [...this.approved]) if (g.startsWith(`${pairId}\0`)) this.approved.delete(g);
  }

  /**
   * The switch, a follow or a pair changed: shells and cards of a device that may no longer mirror the chat end now, not at their
   * next output or write, and a device the Mac switched off is asked again when it is switched back on.
   */
  recheck() {
    for (const s of [...this.sessions.values()]) if (!stillAllowed(this.svc, s.client, s.chatId)) this.#end(s);
    for (const up of this.cards.values()) if (!stillAllowed(this.svc, up.client, up.chatId)) up.card.abort();
    for (const grant of [...this.approved]) if (this.svc.policy.mirrors?.(grant.split('\0')[0]) !== true) this.approved.delete(grant);
  }

  closeAll() {
    for (const s of [...this.sessions.values()]) this.#end(s);
    for (const up of this.cards.values()) up.card.abort();
    this.approved.clear();
  }
}

module.exports = { PtyMirror, HIGH_BYTES, LOW_BYTES, RING_BYTES, SLICE_BYTES, MAX_PER_PAIR };
