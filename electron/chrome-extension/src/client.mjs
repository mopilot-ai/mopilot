// The extension's connection to MoPilot (design D5, B2 step 2): a loopback WebSocket, the mutual pairing handshake, keepalive and reconnects.
//
// - Nothing from MoPilot is acted on before both sides proved the pairing secret (protocol.mjs): a
//   process that is not MoPilot but listens on its port gets no command through.
// - While connected it pings every KEEPALIVE_MS, which also keeps the MV3 service worker alive (Chrome 116+
//   counts WebSocket traffic as activity). A dropped connection is tried again with growing delays; the
//   background's alarm tries again every 30 seconds once the service worker was suspended.
// - When MoPilot goes away, every debugger is let go (sessions.peerGone).
import {
  PROTOCOL_VERSION,
  MEMBERSHIP_CAPABILITY,
  hasMembershipCapability,
  hasPanelTabCapability,
  SOCKET_PATH,
  nonce,
  parsePairingCode,
  proof,
  sameText,
} from './protocol.mjs';

export const KEEPALIVE_MS = 20_000;
export const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
export const CLAIM_MS = 10_000;

/**
 * Trades a one-time claim code for the pairing code at MoPilot's port; resolves with the pairing code, or
 * null when MoPilot doesn't hand one over (a used or expired claim, another program on the port, no answer).
 * @param {any} WebSocket @param {{ port: number, token: string }} claim
 * @param {{ timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }, ms?: number }} [o]
 * @returns {Promise<string | null>}
 */
export function claimPairing(WebSocket, { port, token }, { timers = globalThis, ms = CLAIM_MS } = {}) {
  return new Promise((resolve) => {
    /** @type {any} */
    let ws = null;
    const done = (code) => {
      timers.clearTimeout(timer);
      ws?.close();
      resolve(code);
    };
    const timer = timers.setTimeout(() => done(null), ms);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}${SOCKET_PATH}`);
    } catch {
      done(null);
      return;
    }
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        done(null);
        return;
      }
      if (m?.type === 'hello') {
        ws.send(JSON.stringify({ type: 'claim', protocol: PROTOCOL_VERSION, token }));
        return;
      }
      // the code must be for the port the claim named
      const code = m?.type === 'paired' && parsePairingCode(m.code)?.port === port ? m.code : null;
      done(code);
    };
    ws.onclose = () => done(null);
  });
}

/**
 * @typedef {'unpaired' | 'connecting' | 'connected' | 'unauthorized' | 'offline' | 'update-required'} Status
 *   unpaired: no pairing code yet; unauthorized: the other end did not prove the secret (pair again);
 *   update-required: MoPilot speaks another protocol version (`update` says which side is older)
 */

/** Which side must update when MoPilot's hello names `theirs`: the extension when MoPilot is newer. */
export const olderSide = (/** @type {number} */ theirs) => (theirs > PROTOCOL_VERSION ? 'extension' : 'app');

export class Client {
  /**
   * @param {{ WebSocket: any, crypto: any, pairing: () => Promise<{ port: number, secret: string } | null>,
   *           sessions: { handle: (m: any, reply?: (message: any) => void, memberships?: boolean) => unknown, peerGone: () => unknown }, version: string, ready?: Promise<void>,
   *           timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval },
   *           onStatus?: (status: Status) => void, log?: (what: string, error: unknown) => void,
   *           policy?: () => Promise<{ blockedUrlPatterns: string[] }>, panel?: (m: any) => void }} o policy: the administrator's
   *   (policy.mjs); panel: MoPilot's answers and updates for the side panel (panelLink.mjs)
   */
  constructor(o) {
    this.o = o;
    this.timers = o.timers ?? globalThis;
    /** @type {Status} */
    this.status = 'offline';
    /** @type {any} */
    this.ws = null;
    this.generation = 0;
    this.disposed = false;
    this.authed = false;
    this.panelTabs = false;
    this.retries = 0;
    /** @type {'extension' | 'app' | null} the side to update while the status is update-required */
    this.update = null;
    /** @type {any} */
    this.retryTimer = null;
    /** @type {any} */
    this.pinger = null;
  }

  #set(status) {
    if (this.status === status) return;
    this.status = status;
    this.o.onStatus?.(status);
  }

  /** Connects when it is not connected or connecting (the alarm and the options page call it freely). */
  async connect() {
    const generation = this.generation;
    if (this.disposed) return;
    if (this.o.ready) await this.o.ready;
    if (generation !== this.generation || this.ws) return;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const pairing = await this.o.pairing();
    if (generation !== this.generation || this.ws) return;
    if (!pairing) {
      this.#set('unpaired');
      return;
    }
    let ws;
    try {
      ws = new this.o.WebSocket(`ws://127.0.0.1:${pairing.port}${SOCKET_PATH}`);
    } catch {
      this.#set('offline');
      this.#retry(generation);
      return;
    }
    this.ws = ws;
    this.authed = false;
    /** the handshake's nonces (MoPilot's, then ours), and its messages in order */
    const hs = { theirs: '', mine: '', memberships: false, panelTabs: false, queue: Promise.resolve() };
    // an update the user still has to make stays on screen through the retries
    if (this.status !== 'update-required') this.#set('connecting');
    // until the handshake is done each message waits for the one before (checking a proof takes a moment, and
    // MoPilot may send a chat's first message right after its welcome); then they run side by side
    ws.onmessage = (e) => {
      if (this.authed) return this.#message(ws, pairing.secret, hs, e.data);
      hs.queue = hs.queue.then(() => this.#message(ws, pairing.secret, hs, e.data));
      return hs.queue;
    };
    ws.onclose = () => this.#closed(ws);
    ws.onerror = () => undefined;
  }

  async #message(ws, secret, hs, data) {
    if (ws !== this.ws) return;
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (!this.authed) {
      const c = this.o.crypto;
      if (m.type === 'hello' && m.protocol === PROTOCOL_VERSION && typeof m.nonce === 'string' && !hs.mine) {
        hs.theirs = m.nonce;
        hs.memberships = hasMembershipCapability(m.capabilities);
        hs.panelTabs = hasPanelTabCapability(m.capabilities);
        hs.mine = nonce(c);
        const p = await proof(c, secret, 'extension', hs.theirs, hs.mine);
        // the administrator's blocked sites (policy.mjs), which MoPilot refuses for every agent
        const policy = this.o.policy ? await this.o.policy() : null;
        if (ws !== this.ws) return;
        ws.send(
          JSON.stringify({
            type: 'auth',
            protocol: PROTOCOL_VERSION,
            nonce: hs.mine,
            proof: p,
            version: this.o.version,
            ...(hs.memberships ? { capabilities: [MEMBERSHIP_CAPABILITY] } : {}),
            ...(policy ? { policy } : {}),
          }),
        );
        return;
      }
      if (m.type === 'hello' && Number.isSafeInteger(m.protocol) && m.protocol !== PROTOCOL_VERSION && !hs.mine) {
        // another protocol version: no pairing can help, one side has to update (Claude's "Extension Update Required")
        this.update = olderSide(m.protocol);
        this.#set('update-required');
        ws.close();
        return;
      }
      if (m.type === 'welcome' && hs.mine && sameText(m.proof, await proof(c, secret, 'app', hs.mine, hs.theirs))) {
        if (ws !== this.ws) return;
        hs.memberships = hs.memberships && hasMembershipCapability(m.capabilities);
        this.authed = true;
        this.panelTabs = hs.panelTabs;
        this.retries = 0;
        this.update = null;
        this.pinger = this.timers.setInterval(() => this.send({ type: 'ping' }), KEEPALIVE_MS);
        this.#set('connected');
        return;
      }
      if (ws !== this.ws) return;
      // anything else before both proofs: the other end is not the MoPilot this extension paired with
      this.#set('unauthorized');
      ws.close();
      return;
    }
    // the side panel's answers and updates (panelLink.mjs)
    if (m.type === 'panel') {
      this.o.panel?.(m);
      return;
    }
    if (typeof m.chat === 'string')
      await this.o.sessions.handle(
        m,
        (message) => {
          // Request ids restart on a new connection: late results and errors belong only to this socket.
          if (this.ws === ws) this.send(message);
        },
        hs.memberships,
      );
  }

  /** A message to MoPilot, once the handshake is done; dropped otherwise. */
  send(message) {
    if (this.authed && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  #closed(ws) {
    if (ws !== this.ws) return;
    const generation = ++this.generation;
    this.ws = null;
    this.timers.clearInterval(this.pinger);
    this.pinger = null;
    const was = this.authed;
    this.authed = false;
    if (was) this.#letGo();
    this.panelTabs = false;
    if (this.status !== 'unauthorized' && this.status !== 'update-required') this.#set('offline');
    this.#retry(generation);
  }

  /** MoPilot is gone: every debugger is let go (a failure is logged; the next connection starts clean anyway). */
  #letGo() {
    const failed = (error) => this.o.log?.('let go of the tabs', error);
    try {
      Promise.resolve(this.o.sessions.peerGone()).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  #retry(generation) {
    if (this.disposed || generation !== this.generation) return;
    const ms =
      this.status === 'unauthorized' || this.status === 'update-required'
        ? RETRY_MS.at(-1)
        : RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries++;
    this.timers.clearTimeout(this.retryTimer);
    const timer = this.timers.setTimeout(() => {
      if (generation !== this.generation || this.retryTimer !== timer) return;
      this.retryTimer = null;
      void this.connect();
    }, ms);
    this.retryTimer = timer;
  }

  /** Retires pending reads and callbacks before closing their transport. */
  #retire(releaseSessions) {
    this.generation++;
    const ws = this.ws;
    this.ws = null;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.timers.clearInterval(this.pinger);
    this.pinger = null;
    const was = this.authed;
    this.authed = false;
    if (was && releaseSessions) this.#letGo();
    this.panelTabs = false;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.close();
    }
  }

  /** Terminal transport shutdown; abrupt service-worker death preserves native sessions for restoration. */
  dispose({ releaseSessions = true } = {}) {
    if (this.disposed) return;
    this.disposed = true;
    this.#retire(releaseSessions);
    this.#set('offline');
  }

  /** Drops the connection and connects again with the pairing as it is now (a new code, or none: unpaired). */
  reset() {
    this.#retire(true);
    this.retries = 0;
    this.#set('offline');
    return this.connect();
  }
}
