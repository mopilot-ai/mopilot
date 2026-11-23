// The encrypted session between the app and a Host over the relay (#2709), shared by both ends. Keys reuse the phone's design
// (shared/remote/crypto.mjs): the pair root comes from `deriveRoot` at enrollment; each session opens with a counter-0 hello and
// reply that carry fresh X25519 keys and nonces from both ends (session root = HKDF over the pair root and that exchange, so each
// session has keys of its own and a recorded one cannot be replayed open), then each direction runs the phone's `dirKey` chain and
// counter ratchet with XChaCha20-Poly1305 and the header as AAD. A lost frame is never skipped: the bytes are a stream, so any gap,
// failed tag or relay refusal ends the session, and its streams with it (the Host interface above reconnects as it does over SSH).
//
// Inside the session, records multiplex byte streams (one per local socket connection): open, data, end, reset, credit, ping, pong.
// A stream may send only as many bytes as its receiver granted (`WINDOW`, granted again as the bytes are written out locally), so
// a slow end makes the sender stop reading instead of anything buffering without bound; data goes in records of at most `CHUNK`
// bytes, far under the relay's 256 KB box; small writes made close together go out as one record.
import { createCrypto } from '../remote/crypto.mjs';
import { fromBase64, toBase64, utf8 } from '../remote/envelope.mjs';

/** The most data one record carries: its sealed box stays far under the relay's 256 KB cap. */
export const CHUNK = 64 * 1024;
/** How many bytes a stream may have sent and not yet had written out on the other end. */
export const WINDOW = 1024 * 1024;
/** Writes made within this long of the last record go out together (bounds the frame rate a chatty stream costs). */
export const COALESCE_MS = 15;
/** How often the app measures the round trip, and how many unanswered pings end the session. */
export const PING_MS = 15_000;
const MISSED_PINGS = 2;
const HELLO_MS = 10_000;
const LABEL = 'mopilot-host-session-v1';

/** A timer of the session never keeps its process alive on its own. @template T @param {T} t @returns {T} */
const weak = (t) =>
  (
    /** @type {any} */ (t)?.unref?.(), t
  );

const T = Object.freeze({ open: 1, data: 2, end: 3, reset: 4, credit: 5, ping: 6, pong: 7 });

const concat = (/** @type {Uint8Array[]} */ ...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};

/** @param {number} type @param {number} id @param {Uint8Array} [body] */
function record(type, id, body = new Uint8Array(0)) {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, id);
  out.set(body, 5);
  return out;
}

/** @param {number} n */
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

/** @typedef {{ pair: string, dir: 'm2p' | 'p2m', ctr: number, nonce: string, box: string }} WireFrame */

/**
 * One stream of a session: what one local socket connection sends and receives.
 * @typedef {object} RelayStream
 * @property {number} id
 * @property {(bytes: Uint8Array) => boolean} write false: the window is spent, wait for onCredit before writing more
 * @property {() => void} end no more bytes from this side
 * @property {() => void} reset abandon the stream
 * @property {(n: number) => void} consumed `n` received bytes were written out locally: the sender may send that many more
 * @property {((bytes: Uint8Array) => void) | null} onData
 * @property {(() => void) | null} onEnd
 * @property {((reason: string) => void) | null} onReset
 * @property {(() => void) | null} onCredit
 */

/**
 * @param {object} o
 * @param {import('../remote/crypto.mjs').Primitives} o.prim
 * @param {Uint8Array} o.root the pair root from enrollment
 * @param {string} o.pair the relay pair id
 * @param {'app' | 'host'} o.role the app opens sessions and streams; the Host accepts them
 * @param {(frame: WireFrame) => boolean} o.send hands a frame to the relay socket; false: it is not connected
 * @param {(stream: RelayStream) => void} [o.onStream] the Host's: a stream the app opened
 * @param {(state: 'closed' | 'opening' | 'open', reason: string) => void} [o.onState]
 * @param {() => number} [o.now]
 */
export function createRelaySession({
  prim,
  root,
  pair,
  role,
  send,
  onStream = () => undefined,
  onState = () => undefined,
  now = Date.now,
}) {
  const c = createCrypto(prim);
  const out = role === 'app' ? 'm2p' : 'p2m';
  const inn = role === 'app' ? 'p2m' : 'm2p';
  const openKey = c.hkdf(utf8(LABEL), root, 'open');
  const acceptKey = c.hkdf(utf8(LABEL), root, 'accept');
  /** @type {'closed' | 'opening' | 'open'} */
  let state = 'closed';
  /** @type {{ sk: Uint8Array, pk: Uint8Array, nonce: Uint8Array } | null} */
  let pending = null;
  /** @type {ReturnType<typeof c.createSender> | null} */
  let tx = null;
  /** @type {ReturnType<typeof c.createReceiver> | null} */
  let rx = null;
  let generation = 0;
  let nextStream = 1;
  /** @type {Map<number, any>} */
  const streams = new Map();
  /** @type {Set<{ resolve: () => void, reject: (e: Error) => void }>} */
  const waiting = new Set();
  /** @type {any} */
  let helloTimer = null;
  /** @type {any} */
  let pingTimer = null;
  let unanswered = 0;
  /** @type {number | null} */
  let latencyMs = null;

  const setState = (/** @type {typeof state} */ s, reason = '') => {
    if (state === s) return;
    state = s;
    onState(s, reason);
  };

  /**
   * Seals and sends one record; a socket that does not take it ends the session. Only an open session sends one: its callers are its
   * streams and pings, and close() ends every stream and stops the pings before the keys go.
   * @param {Uint8Array} plain
   */
  function sendRecord(plain) {
    const f = /** @type {NonNullable<typeof tx>} */ (tx).seal(plain);
    if (send({ pair, dir: out, ctr: f.ctr, nonce: toBase64(f.nonce), box: toBase64(f.box) })) return true;
    close('The relay is not connected.');
    return false;
  }

  /** Ends the session and every stream in it. @param {string} reason */
  function close(reason) {
    generation++;
    clearTimeout(helloTimer);
    clearInterval(pingTimer);
    pending = null;
    tx = null;
    rx = null;
    latencyMs = null;
    const all = [...streams.values()];
    streams.clear();
    for (const s of all) s.gone(reason);
    for (const w of [...waiting]) w.reject(new Error(reason));
    waiting.clear();
    setState('closed', reason);
  }

  /** Session keys from both ends' contributions. @param {Uint8Array} ownSk @param {Uint8Array} peerPk @param {Uint8Array} appNonce @param {Uint8Array} hostNonce */
  function begin(ownSk, peerPk, appNonce, hostNonce) {
    const shared = prim.x25519(ownSk, peerPk);
    if (shared.every((b) => b === 0)) throw new Error('a public key of low order');
    const sessionRoot = c.hkdf(concat(appNonce, hostNonce), concat(root, shared), `session|${pair}`);
    tx = c.createSender({ pair, dir: out, chain: c.dirKey(sessionRoot, out) });
    rx = c.createReceiver({ pair, dir: inn, chain: c.dirKey(sessionRoot, inn) });
    unanswered = 0;
    setState('open');
    for (const w of [...waiting]) w.resolve();
    waiting.clear();
  }

  const helloAad = (/** @type {string} */ dir, /** @type {Uint8Array} */ appNonce) => utf8(`${LABEL}|${pair}|${dir}|${toBase64(appNonce)}`);

  /** The app's: starts a session (the Host answers with its half). Resolves once it is open. */
  function start() {
    if (role !== 'app') throw new Error('Only the app opens a session.');
    if (state === 'open') return Promise.resolve();
    const ready = new Promise((resolve, reject) => waiting.add({ resolve: () => resolve(undefined), reject }));
    if (state === 'opening') return ready;
    const sk = prim.randomBytes(32);
    pending = { sk, pk: prim.x25519Base(sk), nonce: prim.randomBytes(16) };
    setState('opening');
    const nonce = prim.randomBytes(24);
    const box = concat(pending.nonce, prim.aeadSeal(openKey, nonce, pending.pk, helloAad('m2p', pending.nonce)));
    const gen = generation;
    helloTimer = weak(setTimeout(() => gen === generation && close('The Host did not answer over the relay.'), HELLO_MS));
    if (!send({ pair, dir: 'm2p', ctr: 0, nonce: toBase64(nonce), box: toBase64(box) })) close('The relay is not connected.');
    return ready;
  }

  /** The Host's answer to an open, or the app's reading of the answer. @param {Uint8Array} nonce @param {Uint8Array} box */
  function hello(nonce, box) {
    if (box.length < 16) return;
    const appNonce = box.subarray(0, 16);
    if (role === 'host') {
      const appPk = prim.aeadOpen(openKey, nonce, box.subarray(16), helloAad('m2p', appNonce));
      if (!appPk || appPk.length !== 32) return;
      // a new open replaces whatever session was there: the app opens one only when it has none
      close('The app opened a new session.');
      const sk = prim.randomBytes(32);
      const hostNonce = prim.randomBytes(16);
      const replyNonce = prim.randomBytes(24);
      const reply = prim.aeadSeal(acceptKey, replyNonce, concat(prim.x25519Base(sk), hostNonce), helloAad('p2m', appNonce));
      try {
        begin(sk, appPk, appNonce, hostNonce);
      } catch {
        return close('The app sent a key that cannot be used.');
      }
      // open before the reply goes: the app's first record may follow it at once
      if (!send({ pair, dir: 'p2m', ctr: 0, nonce: toBase64(replyNonce), box: toBase64(concat(appNonce, reply)) }))
        close('The relay is not connected.');
      return;
    }
    // the app takes only the answer to the open it is waiting for
    if (state !== 'opening' || !pending || toBase64(appNonce) !== toBase64(pending.nonce)) return;
    const half = prim.aeadOpen(acceptKey, nonce, box.subarray(16), helloAad('p2m', appNonce));
    if (!half || half.length !== 48) return;
    clearTimeout(helloTimer);
    const mine = pending;
    pending = null;
    try {
      begin(mine.sk, half.subarray(0, 32), appNonce, half.subarray(32));
      startPings();
    } catch {
      close('The Host sent a key that cannot be used.');
    }
  }

  function startPings() {
    // close() clears this interval, so it runs only for the session that started it
    pingTimer = weak(
      setInterval(() => {
        if (++unanswered > MISSED_PINGS) return close('The Host stopped answering over the relay.');
        sendRecord(record(T.ping, 0, u32(Math.floor(now()) % 2 ** 32)));
      }, PING_MS),
    );
    sendRecord(record(T.ping, 0, u32(Math.floor(now()) % 2 ** 32)));
  }

  /** One frame from the relay for this pair (the wire object). @param {WireFrame} f */
  function handleFrame(f) {
    if (f.pair !== pair || f.dir !== inn) return;
    let nonce;
    let box;
    try {
      nonce = fromBase64(f.nonce);
      box = fromBase64(f.box);
    } catch {
      return state === 'closed' ? undefined : close('The relay sent a frame that cannot be read.');
    }
    if (f.ctr === 0) return hello(nonce, box);
    if (state !== 'open' || !rx) return;
    // a byte stream cannot skip a lost frame
    if (f.ctr !== rx.state().ctr + 1) return close('A frame from the relay was lost.');
    let plain;
    try {
      plain = rx.open({ pair: f.pair, dir: f.dir, ctr: f.ctr, nonce, box });
    } catch {
      return close('A frame from the relay did not open.');
    }
    if (plain.length < 5) return close('A record from the relay is malformed.');
    const type = plain[0];
    const id = new DataView(plain.buffer, plain.byteOffset, plain.length).getUint32(1);
    const body = plain.subarray(5);
    if (type === T.ping) return void sendRecord(record(T.pong, 0, body));
    if (type === T.pong) {
      unanswered = 0;
      if (body.length === 4)
        latencyMs = (Math.floor(now()) - new DataView(body.buffer, body.byteOffset, 4).getUint32(0) + 2 ** 32) % 2 ** 32;
      return;
    }
    if (type === T.open) {
      if (role !== 'host' || streams.has(id)) return void sendRecord(record(T.reset, id));
      const s = makeStream(id);
      streams.set(id, s);
      onStream(s.api);
      return;
    }
    const s = streams.get(id);
    if (!s) return;
    if (type === T.data) return s.data(body);
    if (type === T.end) return s.ended();
    if (type === T.credit && body.length === 4) return s.credit(new DataView(body.buffer, body.byteOffset, 4).getUint32(0));
    if (type === T.reset) {
      streams.delete(id);
      return s.gone('The other end reset the stream.');
    }
  }

  /** @param {number} id */
  function makeStream(id) {
    let credit = WINDOW;
    /** bytes received and written out locally, not yet granted back */
    let owed = 0;
    /** @type {Uint8Array[]} */
    let queued = [];
    let queuedBytes = 0;
    /** set while a record went out less than COALESCE_MS ago: writes wait for that timer, which sends what gathered @type {any} */
    let recent = null;
    let done = false;
    let ending = false;
    let blocked = false;
    /** bytes written past the window, sent once credit comes back @type {Uint8Array | null} */
    let rest = null;

    const flush = () => {
      if (!queuedBytes) return;
      const all = queued.length === 1 ? queued[0] : concat(...queued);
      queued = [];
      queuedBytes = 0;
      for (let o = 0; o < all.length; o += CHUNK) if (!sendRecord(record(T.data, id, all.subarray(o, o + CHUNK)))) return;
      clearTimeout(recent);
      recent = weak(
        setTimeout(() => {
          recent = null;
          flush();
        }, COALESCE_MS),
      );
    };
    /** @type {RelayStream} */
    const api = {
      id,
      write(bytes) {
        if (done || ending) return false;
        // already waiting for credit: the bytes join what waits
        if (rest) {
          rest = concat(rest, bytes);
          return false;
        }
        // the window is the sender's promise: past it the caller stops reading (it hears onCredit), it is never queued
        const take = Math.min(bytes.length, credit);
        if (take > 0) {
          queued.push(take === bytes.length ? bytes : bytes.subarray(0, take));
          queuedBytes += take;
          credit -= take;
        }
        if (take < bytes.length) {
          // the caller paused on false and resends the rest after onCredit
          rest = bytes.subarray(take);
          blocked = true;
          flush();
          return false;
        }
        // the first write after a quiet spell goes at once; the ones right after it go together when the window ends
        if (queuedBytes >= CHUNK || !recent) flush();
        if (credit === 0) blocked = true;
        return credit > 0;
      },
      end() {
        if (done || ending) return;
        ending = true;
        flush();
        sendRecord(record(T.end, id));
      },
      reset() {
        if (done) return;
        done = true;
        clearTimeout(recent);
        streams.delete(id);
        sendRecord(record(T.reset, id));
      },
      consumed(n) {
        if (done) return;
        owed += n;
        // credit goes back in large steps, so it costs a record per half window, not one per chunk
        if (owed >= WINDOW / 2) {
          sendRecord(record(T.credit, id, u32(owed)));
          owed = 0;
        }
      },
      onData: null,
      onEnd: null,
      onReset: null,
      onCredit: null,
    };
    return {
      api,
      /** @param {Uint8Array} body */
      // the session calls these only for a stream it still holds, and a stream leaves it the moment it is done
      data(body) {
        api.onData?.(body);
      },
      ended() {
        api.onEnd?.();
      },
      /** @param {number} n */
      credit(n) {
        credit = Math.min(WINDOW, credit + n);
        if (blocked && credit > 0) {
          blocked = false;
          const waiting = rest;
          rest = null;
          if (waiting && !api.write(waiting)) return;
          api.onCredit?.();
        }
      },
      /** @param {string} reason */
      gone(reason) {
        done = true;
        clearTimeout(recent);
        api.onReset?.(reason);
      },
    };
  }

  return {
    get state() {
      return state;
    },
    /** The last measured round trip through the relay, or null (no session, or not measured yet). */
    get latencyMs() {
      return latencyMs;
    },
    start,
    handleFrame,
    close,
    /** The app's: a new stream in the open session. */
    openStream() {
      if (role !== 'app') throw new Error('Only the app opens streams.');
      if (state !== 'open') throw new Error('The relay session is not open.');
      const id = nextStream++;
      const s = makeStream(id);
      streams.set(id, s);
      sendRecord(record(T.open, id));
      return s.api;
    },
    /** How many streams are open. */
    get streams() {
      return streams.size;
    },
  };
}

/**
 * Joins a local socket to a stream, both ways, with backpressure: the socket is paused while the stream's window is spent, and a
 * received chunk is granted back only once the socket has written it out.
 * @param {RelayStream} stream
 * @param {import('node:net').Socket} socket
 */
export function pipeSocket(stream, socket) {
  let closed = false;
  socket.on('data', (/** @type {Buffer} */ chunk) => {
    if (!stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length))) socket.pause();
  });
  stream.onCredit = () => socket.resume();
  // bytes written into a socket that has not flushed them yet: granted back together when it drains
  let unflushed = 0;
  stream.onData = (bytes) => {
    const flushed = socket.write(bytes);
    if (flushed && !unflushed) return stream.consumed(bytes.length);
    if (!unflushed) socket.once('drain', () => (stream.consumed(unflushed), (unflushed = 0)));
    unflushed += bytes.length;
  };
  // the other end said it is done: what it sent is still written out before the socket closes, so a reset that follows its end
  // (its own socket closing) never cuts the tail off
  let ended = false;
  stream.onEnd = () => {
    ended = true;
    socket.end();
  };
  stream.onReset = () => {
    closed = true;
    if (!ended) socket.destroy();
  };
  socket.on('end', () => stream.end());
  socket.on('error', () => undefined);
  socket.on('close', () => {
    if (!closed) stream.reset();
  });
}
