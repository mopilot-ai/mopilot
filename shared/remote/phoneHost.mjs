// The phone as a client of a Host (#2709, P3): the Host's own line protocol over the encrypted relay session (shared/host/relaySession.mjs), with the phone's primitive set. Pure: the relay socket and the primitives are injected, there is no Buffer and no node API (the Hermes engine has neither), so the same file runs in the app and the background window.
import { createRelaySession } from '../host/relaySession.mjs';
import { PROTOCOL, negotiate } from '../host/protocol.mjs';
import { toBase64, toHex, utf8 } from './envelope.mjs';

/** How long a request waits for the Host's reply. */
export const REQUEST_MS = 30_000;
/** The most a line may hold before the Host is cut off (the Host's own frame cap). */
const MAX_LINE = 8 * 1024 * 1024;
/** The DER prefix of an Ed25519 public key: the Host registers a client by its base64 SPKI. */
const ED_SPKI = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00);
/** What the phone needs of a Host for a card: without these it says "Update <machine>". */
export const CARD_FEATURES = Object.freeze(['epoch', 'dedupe', 'approvals2']);

/** What the phone declares in `host.hello` (a feature is on only when both ends declare it): spelled out, since schema.mjs, which lists the Host's own, reads method files from disk and is not for the phone bundle. A test holds every one of these to the Host's list. */
export const PHONE_FEATURES = Object.freeze([
  'journalLifecycle',
  'historyPages',
  'epoch',
  'dedupe',
  'isolation',
  'lanes',
  'origin',
  'family',
  'switch',
  'chatList',
  'tools',
  'stream2',
  'hostRead',
  'chatImages',
  'policy',
  'spend',
  'approvals2',
  'clients',
  'relay',
  // MoMo's home on a Host: the phone's own look at what each Host holds, and the requests of the home's lanes (host.momo*)
  'momo',
  'momoLook',
]);

export class PhoneHostError extends Error {
  /** @param {string} code @param {string} message @param {{ by?: { name?: string }, at?: number, current?: number }} [details] */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PhoneHostError';
    this.code = code;
    /** What the Host said beside its refusal (who answered a card first, and when). */
    this.details = details;
  }
}

/** A key for one tap: minted once, reused by every retry of that tap, so a retry is the same request. @param {{ randomBytes: (n: number) => Uint8Array }} prim */
export const mintKey = (prim) => `phone-${toHex(prim.randomBytes(12))}`;

/** Why a session ends when a new connect replaces it: not an end the chats followed through it need to hear of. */
export const REPLACED = 'A new connection replaced this one.';

/**
 * @param {object} o
 * @param {import('./crypto.mjs').Primitives} o.prim the phone's primitive set
 * @param {{ root: Uint8Array, pairId: string, hostKey: string }} o.enrollment the pair root, the relay pair and the Host's own id (config/host-id), which a proof is signed over
 * @param {{ pk: Uint8Array, sk: Uint8Array }} o.identity the phone's Ed25519 key, registered on the Host by `host.clientAdd`
 * @param {(frame: import('../host/relaySession.mjs').WireFrame) => boolean} o.send hands a frame to the relay's Host-lane socket
 * @param {(state: 'closed' | 'opening' | 'open', reason: string) => void} o.onState
 * @param {(event: Record<string, any>) => void} [o.onEvent] a line that is an event, not a reply
 * @param {number} [o.requestMs]
 * @param {number} [o.maxLine]
 */
export function createPhoneHost({ prim, enrollment, identity, send, onState, onEvent, requestMs = REQUEST_MS, maxLine = MAX_LINE }) {
  const publicKey = toBase64(Uint8Array.of(...ED_SPKI, ...identity.pk));
  const encoder = new TextEncoder();
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any }>} */
  const waiting = new Map();
  /** @type {ReturnType<ReturnType<typeof createRelaySession>['openStream']> | null} */
  let stream = null;
  const decoder = new TextDecoder();
  /** @type {Uint8Array} */
  let held = new Uint8Array(0);
  let nextId = 1;
  /** @type {{ minor: number, features: string[] } | null} */
  let negotiated = null;

  const session = createRelaySession({
    prim,
    root: enrollment.root,
    pair: enrollment.pairId,
    role: 'app',
    send,
    onState: (s, reason) => {
      if (s !== 'open') endStream(reason || 'The session ended.');
      onState(s, reason);
    },
  });

  /** Fails every request in flight and forgets the stream. @param {string} reason */
  function endStream(reason) {
    stream = null;
    negotiated = null;
    held = new Uint8Array(0);
    for (const [id, w] of [...waiting]) {
      clearTimeout(w.timer);
      waiting.delete(id);
      w.reject(new PhoneHostError('unreachable', reason));
    }
  }

  /** The Host's refusal as an error: its own code, or `refused`. @param {any} msg */
  function refusal(msg) {
    const code = msg.code;
    // a stale epoch names the chat's current one beside its details
    const details = Number.isSafeInteger(msg.current) ? { ...msg.details, current: msg.current } : msg.details;
    return new PhoneHostError(code === undefined ? 'refused' : String(code), String(msg.error), details);
  }

  /** @param {string} line */
  function onLine(line) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    if (typeof msg.id === 'number' && waiting.has(msg.id)) {
      const w = /** @type {NonNullable<ReturnType<typeof waiting.get>>} */ (waiting.get(msg.id));
      clearTimeout(w.timer);
      waiting.delete(msg.id);
      if ('error' in msg) w.reject(refusal(msg));
      else w.resolve(msg.result);
    } else if (msg.event !== undefined) onEvent?.(msg);
  }

  /** @param {Uint8Array} bytes */
  function onData(bytes) {
    // a binary frame (a first byte of 0) is not part of anything the phone asks for
    if (held.length === 0 && bytes[0] === 0) return session.close('The Host sent a frame the phone does not read.');
    const all = new Uint8Array(held.length + bytes.length);
    all.set(held);
    all.set(bytes, held.length);
    let start = 0;
    for (let at = all.indexOf(10, start); at >= 0; at = all.indexOf(10, start)) {
      // whole lines only: a multi-byte character is never cut, so no streaming decoder is needed
      if (at > start) onLine(decoder.decode(all.subarray(start, at)));
      start = at + 1;
    }
    held = all.slice(start);
    stream?.consumed(bytes.length);
    if (held.length > maxLine) session.close('The Host sent a line that is too long.');
  }

  /** One request on the open stream: resolves with the result, rejects with the Host's code, or `timeout` after `requestMs`. @param {string} method @param {object} [params] */
  function request(method, params = {}) {
    const s = stream;
    if (!s) return Promise.reject(new PhoneHostError('unreachable', 'The Host is not connected.'));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new PhoneHostError('timeout', 'The Host did not answer.'));
      }, requestMs);
      /** @type {any} */ (timer)?.unref?.();
      waiting.set(id, { resolve, reject, timer });
      s.write(encoder.encode(`${JSON.stringify({ id, method, params })}\n`));
    });
  }

  /** Opens the session, proves the key, says hello. Answers what both ends can do. */
  async function connect() {
    // always a fresh session: a connect that finds one open or opening replaces it, and its requests fail
    session.close(REPLACED);
    await session.start();
    const s = session.openStream();
    s.onData = onData;
    s.onEnd = () => endStream('The Host closed the connection.');
    s.onReset = (reason) => endStream(reason);
    stream = s;
    try {
      const c = await request('host.challenge');
      if (c?.hostId !== enrollment.hostKey) throw new PhoneHostError('wrong_host', 'This is not the machine the phone was set up with.');
      const sig = prim.edSign(identity.sk, utf8(`auth\n${c.hostId}\n${c.nonce}`));
      await request('host.auth', {
        publicKey,
        nonce: c.nonce,
        signature: toBase64(sig),
      });
      const mineHello = {
        protocol: { ...PROTOCOL },
        features: [...new Set([...PHONE_FEATURES, ...CARD_FEATURES])],
      };
      const theirs = await request('host.hello', mineHello);
      negotiated = negotiate(mineHello, {
        protocol: theirs.protocol ?? { minor: 0, floor: 0 },
        features: theirs.features ?? [],
      });
      return { ...negotiated, hello: theirs };
    } catch (e) {
      if (stream === s) {
        stream = null;
        s.reset();
      }
      throw e;
    }
  }

  /** Whether the Host speaks what a card needs, else the machine row says "Update <machine>". */
  const supportsCards = () => !!negotiated && CARD_FEATURES.every((f) => negotiated?.features.includes(f));

  /** Whether the Host can list the chats it holds (`host.chats`); an older Host cannot, and the phone then knows only the chats it started itself. */
  const supportsChatList = () => !!negotiated?.features.includes('chatList');

  return {
    connect,
    handleFrame: (/** @type {any} */ f) => session.handleFrame(f),
    close(reason = 'The phone closed the connection.') {
      session.close(reason);
    },
    get state() {
      return session.state;
    },
    get negotiated() {
      return negotiated;
    },
    supportsCards,
    supportsChatList,
    request,
    /** What the Host reports of itself: its agents (harnesses) installed and signed in, among others. */
    status: () => request('host.status'),
    /** The chats the Host holds, newest activity first, at most `limit` (feature `chatList`). @param {{ limit?: number }} [p] */
    chats: (p = {}) => request('host.chats', p),
    /** The cards the Host waits on. The latest answer wins: callers replace, never merge. */
    pending: () => request('host.pending'),
    /** @param {{ chatId: string, epoch: number, requestId: string, optionId?: string, form?: object, key: string }} p */
    answer: (p) => request('chat.answer', p),
    /** @param {{ chatId: string, epoch: number, key: string, turnId?: string }} p */
    stop: (p) => request('chat.stop', p),
    /** Moves a chat to another agent on its machine with its next message (feature `switch`). @param {{ chatId: string, epoch: number, key: string, harness: string, model?: string, effort?: string }} p */
    switchTo: (p) => request('chat.switch', p),
    /** Sets the chat's permission mode. @param {{ chatId: string, epoch: number, key: string, value: string }} p */
    permit: (p) => request('chat.permit', p),
    /** @param {{ chatId: string, epoch: number, key: string, [k: string]: unknown }} p */
    send: (p) => request('chat.send', p),
    /** The chat's state and the stream after `fromRev` (X4). @param {{ chatId: string, epoch: number, fromRev?: number, generation?: string }} p */
    subscribe: (p) => request('chat.subscribe', p),
    /** A new chat on the Host (X4). @param {{ epoch: number, key: string, [k: string]: unknown }} p */
    start: (p) => request('chat.start', p),
    /** One page of a chat's history, pinned to the epoch, generation and revision (X4). @param {{ chatId: string, epoch: number, generation: string, rev: number, index: number, offset: number }} p */
    history: (p) => request('chat.history', p),
  };
}
