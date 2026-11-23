// Computer access (#1364): a client MoPilot's connection to a paired computer (or to one it is pairing with). The
// handshake proves both keys first (handshake.cjs); from then on every message is an encrypted frame (frames.cjs). A
// call waits for its own result by call id; the connection ending fails every call still waiting, and nothing the
// computer sends is read before it proved the key this install pinned (or, pairing, the offer's fingerprint).
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { clientHello, clientFinish } = require('./handshake.cjs');
const { SecureChannel } = require('./frames.cjs');
const { noteIgnored } = require('../ignored.cjs');

const HANDSHAKE_MS = 10_000;
/** How long a call may wait for its result (a card can keep it waiting for a person). */
const CALL_MS = 10 * 60_000;
/** What a computer may send once the connection is open. */
const PUSHES = new Set(['result', 'tools', 'approval', 'withdraw', 'stop', 'answered', 'paired', 'denied', 'error', 'pong']);

class ClientConnection extends EventEmitter {
  /**
   * @param {{ url: string, identity: { x: string, d: string }, hostKey?: string | null,
   *   pair?: { name: string, secret: string, fingerprint: string } | null, WebSocket?: any,
   *   handshakeMs?: number, callMs?: number, now?: () => number }} o
   * Events: 'approval', 'withdraw', 'stop', 'answered', 'denied', 'refused' (the computer's pushes, as messages);
   * 'paired' ({ host, device }); 'close' (code, reason).
   */
  constructor(o) {
    super();
    this.o = o;
    this.now = o.now ?? Date.now;
    /** @type {'connecting' | 'confirm' | 'pairing' | 'open' | 'closed'} */
    this.phase = 'connecting';
    /** @type {InstanceType<typeof SecureChannel> | null} */
    this.channel = null;
    /** @type {string | null} the computer's key, once it proved it */
    this.host = null;
    /** @type {string | null} the code both sides show while pairing */
    this.code = null;
    /** call id -> its waiting call */
    this.calls = new Map();
    /** @type {((m: any) => void)[]} waiting for the tool list */
    this.toolWaits = [];
  }

  get open() {
    return this.phase === 'open';
  }

  /**
   * Connects and runs the handshake. Resolves once the connection is open (a paired computer) or, pairing, once the
   * computer proved the offer (`code` to compare; `paired()` then waits for the person there).
   * @returns {Promise<{ host: string, code: string | null }>}
   */
  connect() {
    const WS = this.o.WebSocket ?? globalThis.WebSocket;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error("The computer didn't answer in time"));
        this.close();
      }, this.o.handshakeMs ?? HANDSHAKE_MS);
      timer.unref?.();
      const ws = new WS(this.o.url);
      this.ws = ws;
      const hello = clientHello({
        identity: this.o.identity,
        pair: this.o.pair ? { name: this.o.pair.name, secret: this.o.pair.secret } : null,
      });
      ws.addEventListener('open', () => ws.send(JSON.stringify(hello.message)));
      ws.addEventListener('message', (ev) => {
        try {
          if (this.phase === 'connecting') {
            const done = clientFinish({
              state: hello.state,
              welcome: JSON.parse(String(ev.data)),
              hostKey: this.o.hostKey ?? null,
              fingerprint: this.o.pair?.fingerprint ?? null,
            });
            this.channel = new SecureChannel(done.session);
            this.host = done.host;
            this.code = done.code;
            ws.send(JSON.stringify(done.message));
            this.phase = this.o.pair ? 'pairing' : 'open';
            clearTimeout(timer);
            settled = true;
            resolve({ host: done.host, code: done.code });
            return;
          }
          this.#push(/** @type {any} */ (this.channel).open(String(ev.data)));
        } catch (error) {
          fail(error);
          this.close(4400, /** @type {Error} */ (error).message);
        }
      });
      ws.addEventListener('close', (ev) => {
        clearTimeout(timer);
        fail(new Error(closeText(ev.code, ev.reason)));
        this.#gone(ev.code, ev.reason);
      });
      ws.addEventListener('error', () => {
        // the close event that follows says why; a connect that never opened fails there
      });
    });
  }

  /** A message from the computer, once the keys are proved. */
  #push(m) {
    if (!m || typeof m !== 'object' || !PUSHES.has(m.t)) return this.close(4400, 'unknown message');
    if (m.t === 'result') {
      const call = this.calls.get(m.callId);
      if (!call) return;
      this.calls.delete(m.callId);
      clearTimeout(call.timer);
      const ok = m.ok === true;
      // a refusal always has a code and words, whatever the computer sent
      const error = ok
        ? null
        : { code: String(m.error?.code ?? 'failed'), message: String(m.error?.message ?? 'The computer refused the call') };
      return call.resolve({ ok, content: Array.isArray(m.content) ? m.content : [], error });
    }
    if (m.t === 'tools') {
      const waits = this.toolWaits.splice(0);
      for (const w of waits) w(Array.isArray(m.tools) ? m.tools : []);
      return;
    }
    if (m.t === 'paired') {
      this.phase = 'open';
      return this.emit('paired', { host: m.host, device: m.device });
    }
    // the computer refused this device's request (it was removed there): never an EventEmitter 'error', which throws
    // when nothing listens; the close that follows fails what is still waiting
    if (m.t === 'error') return this.emit('refused', m);
    this.emit(m.t, m);
  }

  /**
   * Waits for the person on the computer to allow this pairing.
   * @returns {Promise<{ host: string, device: string }>}
   */
  paired() {
    if (this.phase === 'open') return Promise.reject(new Error('This connection is not pairing'));
    return new Promise((resolve, reject) => {
      const onPaired = (p) => {
        this.off('close', onClose);
        resolve(p);
      };
      const onClose = (code, reason) => {
        this.off('paired', onPaired);
        reject(new Error(closeText(code, reason)));
      };
      this.once('paired', onPaired);
      this.once('close', onClose);
    });
  }

  /** An encrypted message to the computer; false when the connection can't carry one. */
  send(message) {
    if (!this.channel || this.phase === 'closed') return false;
    try {
      this.ws.send(this.channel.seal(message));
      return true;
    } catch (error) {
      noteIgnored('send a computer access message', error);
      return false;
    }
  }

  /** The tools this device may use on the computer. */
  tools() {
    if (!this.open) return Promise.reject(new Error('Not connected to the computer'));
    return new Promise((resolve) => {
      this.toolWaits.push(resolve);
      this.send({ t: 'tools' });
    });
  }

  /**
   * Runs a tool on the computer for a chat here.
   * @param {{ chat: string, turn: string, harness?: string, model?: string | null, anchor?: string, human?: boolean,
   *   unattended?: boolean, tool: string, args?: any }} c
   * @returns {Promise<{ ok: boolean, content: any[], error: { code: string, message: string } }>} (error: null when ok)
   */
  call(c) {
    if (!this.open) return Promise.reject(new Error('Not connected to the computer'));
    const callId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(callId);
        reject(new Error("The computer didn't finish the call in time"));
      }, this.o.callMs ?? CALL_MS);
      timer.unref?.();
      this.calls.set(callId, { resolve, reject, timer });
      this.send({ t: 'call', callId, issuedAt: this.now(), ...c });
    });
  }

  /** Tells the computer the chat's turn ended here. */
  turnEnded(chat) {
    return this.send({ t: 'turnEnded', chat });
  }

  /** A person's answer to a card the computer sent. */
  answer(id, result) {
    return this.send({ t: 'answer', id, result });
  }

  close(code = 1000, reason = '') {
    if (this.phase === 'closed') return;
    try {
      this.ws?.close(code, reason);
    } catch (error) {
      noteIgnored('close a computer access connection', error);
    }
    this.#gone(code, reason);
  }

  #gone(code, reason) {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    const why = new Error(closeText(code, reason));
    for (const [, call] of this.calls) {
      clearTimeout(call.timer);
      call.reject(why);
    }
    this.calls.clear();
    for (const w of this.toolWaits.splice(0)) w([]);
    this.emit('close', code, reason);
  }
}

/** What a close means to the person, from the computer's close code. */
function closeText(code, reason) {
  const known = {
    4401: "The computer didn't accept this device's key",
    4403: 'This device is not paired with that computer',
    4404: 'That computer is not pairing a device right now (the code expired or was used)',
    4408: 'The computer stopped waiting for the handshake',
    4410: 'This device was removed on that computer',
    4503: 'Computer access is off on that computer',
  };
  return known[code] ?? (reason ? String(reason) : `The connection to the computer closed (${code})`);
}

module.exports = { ClientConnection, closeText, PUSHES };
