// This Mac's side of pairing by code in the app (R2b of #5576, `live.codePairHost` behind electron/app/ipc/codePair.cjs): one connection to this Mac's own Host as its CLI (the token beside the socket), which makes offers, tells every step of a run as `codePair:event`, and answers the person's Allow with the proof of native/code-pair-approve (electron/host/codePairApprove.cjs). An offer belongs to the connection that made it, so the connection is kept while offers are open; when it drops, every open offer is told as ended.
const net = require('node:net');
const { fs } = require('../platform/ports/fs.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const frames = require('../../shared/host/frames.mjs');
const { helloParams } = require('../../shared/host/schema.mjs');

/** How long the Host has to answer one request (an Allow waits on the person in the helper, not here). */
const REQUEST_MS = 15_000;
/** Phases after which an offer is over. */
const ENDED = new Set(['done', 'denied', 'used_up', 'expired', 'cancelled', 'failed']);

/** The relay's HTTP origin for its WebSocket URL (the Host's offer takes the HTTP base). @param {string} wsUrl */
const httpBase = (wsUrl) => {
  const u = new URL(wsUrl);
  return `${u.protocol === 'ws:' ? 'http:' : 'https:'}//${u.host}`;
};

/** A refusal with a code the windows word (shared/host/refusalWordsCodePair.mjs). @param {string} code @param {string} [message] */
const refusal = (code, message = code) => Object.assign(new Error(message), { code });
/** What a call answers when it fails: the code only, never a raw message. @param {unknown} error */
const failed = (error) => ({ error: { code: String(/** @type {any} */ (error)?.code || 'failed') } });

/**
 * One CLI connection to the Host: hello, then requests by id; the Host's pushed lines (`{ event: 'codePair', … }`) go to `onPush`.
 * @param {{ socketPath: string, token: string, connect: (p: string) => import('node:net').Socket, onPush: (m: any) => void, onClose: () => void, report: (e: unknown) => void, timeoutMs: number }} o
 */
function openLine({ socketPath, token, connect, onPush, onClose, report, timeoutMs }) {
  const socket = connect(socketPath);
  const decoder = frames.createDecoder();
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any }>} */
  const waiting = new Map();
  let next = 1;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const w of waiting.values()) {
      clock.clearTimeout(w.timer);
      w.reject(refusal('host_unreachable', 'This Mac’s Host closed the connection.'));
    }
    waiting.clear();
    socket.destroy();
    onClose();
  };
  socket.on('error', close);
  socket.on('close', close);
  socket.on('data', (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      // a line this app cannot read ends the connection: the offers on it are told as ended
      report(error);
      return close();
    }
    for (const f of messages) {
      if (f.kind !== 'control') continue;
      const m = f.message;
      const w = typeof m.id === 'number' ? waiting.get(m.id) : undefined;
      if (!w) {
        if (m.event === 'codePair') onPush(m);
        continue;
      }
      waiting.delete(m.id);
      clock.clearTimeout(w.timer);
      if (m.error !== undefined) w.reject(refusal(m.code || 'failed', String(m.error)));
      else w.resolve(m.result);
    }
  });
  /** @param {string} method @param {object} params @returns {Promise<any>} */
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = clock.setTimeout(() => {
        waiting.delete(id);
        reject(refusal('host_unreachable', 'This Mac’s Host did not answer.'));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      socket.write(frames.encodeControl({ id, method, params, token }));
    });
  const ready = request('host.hello', helloParams());
  return {
    request,
    ready,
    close,
    get closed() {
      return closed;
    },
  };
}

/**
 * @param {object} o
 * @param {() => string} o.socketPath this Mac's own Host's socket ('' while there is none)
 * @param {() => string | null} o.relayUrl the relay's WebSocket URL (electron/host/relayPaths.cjs `relayUrl`)
 * @param {() => Promise<string | null>} o.relayToken the account's relay token (null while signed out)
 * @param {() => boolean} o.connections the "Allow connections" switch
 * @param {{ enrol: (hostId: string) => Promise<{ key: string, weak: boolean, signature: string }>, commit: () => Promise<unknown>, abort: () => Promise<unknown>, reset: () => Promise<unknown>, approve: (fields: object) => Promise<{ sig: string }> }} o.approver
 * @param {(p: string) => import('node:net').Socket} [o.connect]
 * @param {(socketPath: string) => string} [o.readToken]
 * @param {number} [o.timeoutMs]
 * @param {(error: unknown) => void} [o.report] a line from the Host this app cannot read, or a failure that is noted
 * @param {() => number} [o.now]
 */
function createCodePairHost({
  socketPath,
  relayUrl,
  relayToken,
  connections,
  approver,
  connect = net.connect,
  readToken = (p) => fs.readFileSync(`${p}.token`, 'utf8'),
  timeoutMs = REQUEST_MS,
  report = () => undefined,
  now = Date.now,
}) {
  /** @type {Set<(e: object) => void>} */
  const listeners = new Set();
  /** Offers made on the current connection that have not ended: their phase, when the question runs out, and whether an Allow is being taken. @type {Map<string, { phase: string, deadline: number, asking: boolean }>} */
  const open = new Map();
  /** @type {ReturnType<typeof openLine> | null} */
  let line = null;
  /** @param {object} e */
  const tell = (e) => {
    for (const fn of listeners) fn(e);
  };
  /** The connection, opened on first use and again after it dropped. */
  /** The connection being opened, so calls that come together share it (an offer belongs to the connection that made it). @type {Promise<ReturnType<typeof openLine>> | null} */
  let connecting = null;
  /** The connection, opened on first use and again after it dropped; one at a time. */
  function connection() {
    if (line && !line.closed) return Promise.resolve(line);
    connecting ??= openConnection().then(
      (made) => ((connecting = null), made),
      (error) => {
        connecting = null;
        throw error;
      },
    );
    return connecting;
  }
  /** Opens a connection and says hello: it is the one in use only once the Host answered, and is closed when it did not. */
  async function openConnection() {
    const at = socketPath();
    if (!at) throw refusal('host_unreachable', 'This Mac has no Host running.');
    let token;
    try {
      token = readToken(at);
    } catch (error) {
      throw refusal('host_unreachable', `This Mac’s Host is not reachable: ${error}`);
    }
    const made = openLine({
      socketPath: at,
      token,
      connect,
      timeoutMs,
      report,
      onPush: (/** @type {any} */ m) => {
        const { event: _event, ...e } = m;
        const o = open.get(e.offerId);
        if (ENDED.has(e.phase)) open.delete(e.offerId);
        else if (o) {
          o.phase = e.phase;
          if (e.phase === 'confirm') o.deadline = now() + (Number(e.expiresInMs) || 0);
        }
        tell(e);
      },
      onClose: () => {
        // only the connection in use holds offers: one whose hello failed was never in use, so it cancels nothing
        if (line !== made) return;
        // the Host ends the offers of a connection that is gone: the windows are told so
        for (const offerId of open.keys()) tell({ offerId, phase: 'cancelled', code: 'host_unreachable' });
        open.clear();
        line = null;
      },
    });
    let hello;
    try {
      hello = await made.ready;
    } catch (error) {
      made.close();
      throw error;
    }
    if (!hello?.agreed?.features?.includes?.('codePair')) {
      made.close();
      throw refusal('unsupported', 'This Mac’s Host does not pair by code.');
    }
    line = made;
    return made;
  }
  /** Whether a set-up is running (one at a time). */
  let settingUp = false;
  /** Keeps the staged key, trying once more: a key the Host accepted but the helper did not keep can only be repaired by a reset. */
  async function keepStaged() {
    try {
      await approver.commit();
    } catch (first) {
      report(first);
      try {
        await approver.commit();
      } catch (second) {
        report(second);
        throw refusal('approval_out_of_sync', 'This Mac’s approval key was not kept. Reset approval, then set it up again.');
      }
    }
  }
  /** One set-up: throws its refusal (setup() turns it into an answer and ends the set-up whatever happens). */
  async function setupOnce() {
    const { hostId, approval } = await ask('host.codePair.status');
    // only a Host with no key enrolled is set up: the helper (and its prompt) is not run otherwise
    if (approval?.available) throw refusal('already_enrolled', 'This Mac already has an approval key.');
    const proof = await approver.enrol(String(hostId));
    let kept;
    try {
      kept = await ask('host.codePair.enrol', proof);
    } catch (error) {
      // the Host did not take the new key: the helper drops it and keeps the one the Host knows
      await approver.abort().catch(report);
      throw error;
    }
    await keepStaged();
    return kept;
  }

  /** @param {string} method @param {object} [params] */
  const ask = async (method, params = {}) => (await connection()).request(method, params);
  return {
    /** What the Computer pane shows: whether this Mac can ask for an approval, the switch, and its offers. */
    async status() {
      try {
        const s = await ask('host.codePair.status');
        return { approval: s.approval, connections: connections(), offers: s.offers, hostId: s.hostId };
      } catch (error) {
        return {
          approval: { available: false, reason: failed(error).error.code },
          connections: connections(),
          offers: [],
        };
      }
    },
    /** The one-time set-up: the helper makes this user's key (and asks the person), the Host keeps its public half. */
    async setup() {
      // one set-up at a time: a second click while the first prompts would run the helper twice and race its staged key
      if (settingUp) return failed(refusal('busy'));
      settingUp = true;
      // every way setupOnce ends becomes an answer (`failed` never throws), so the set-up always ends
      const result = await setupOnce().then((kept) => kept, failed);
      settingUp = false;
      return result;
    },
    /** This Mac's code, made at the relay on the account's token. */
    async offer() {
      try {
        const url = relayUrl();
        if (!url) throw refusal('relay', 'No relay is set up.');
        const token = await relayToken();
        if (!token) throw refusal('unauthorized', 'Sign in to MoPilot to make a code.');
        const made = await ask('host.codePair.offer', { relayUrl: httpBase(url), token });
        open.set(made.offerId, { phase: 'waiting', deadline: 0, asking: false });
        return made;
      } catch (error) {
        return failed(error);
      }
    },
    /** The person's Allow: the Host's fields to the helper (the system prompt), then its signature as the answer's proof. A cancelled prompt answers nothing (the question stays). @param {{ offerId: string }} p */
    async allow({ offerId }) {
      // only the question that is open now, within its time, and once at a time: no prompt for a dead offer or a second Allow
      const o = open.get(offerId);
      if (!o) return failed(refusal('no_such_offer'));
      if (o.phase !== 'confirm') return failed(refusal('not_asked'));
      if (now() >= o.deadline) return failed(refusal('expired'));
      if (o.asking) return failed(refusal('busy'));
      o.asking = true;
      /** @type {any} */
      let result;
      try {
        const { fields } = await ask('host.codePair.approvalText', { offerId });
        const approval = await approver.approve(fields);
        result = await ask('host.codePair.answer', { offerId, accept: true, approval });
      } catch (error) {
        result = failed(error);
      }
      o.asking = false;
      return result;
    },
    /** @param {{ offerId: string }} p */
    async deny({ offerId }) {
      try {
        return await ask('host.codePair.answer', { offerId, accept: false });
      } catch (error) {
        return failed(error);
      }
    },
    /** @param {{ offerId: string }} p */
    async cancel({ offerId }) {
      try {
        return await ask('host.codePair.cancel', { offerId });
      } catch (error) {
        return failed(error);
      }
    },
    /**
     * Resets pairing approval: this Mac's Host first (every Mac paired by code goes, then its key), then the helper's own key. Refused while a code is open or a set-up runs. A step that fails answers `reset_incomplete`, and resetting again finishes it (each step is safe to repeat); a helper reset that fails also leaves nothing a new set-up does not replace, since set-up always makes a new key.
     */
    async resetApproval() {
      if (open.size > 0 || settingUp) return failed(refusal('busy'));
      try {
        const done = await ask('host.codePair.resetApproval');
        try {
          await approver.reset();
        } catch (error) {
          // no helper is no key to remove; anything else is said
          if (/** @type {any} */ (error)?.code !== 'no_helper') {
            report(error);
            throw refusal('reset_incomplete', 'Resetting pairing approval did not finish. Reset it again.');
          }
        }
        return done;
      } catch (error) {
        return failed(error);
      }
    },
    /** Every step of a run, for the windows. @param {(e: object) => void} fn @returns {() => void} */
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Ends the connection (the Host ends its offers). */
    dispose() {
      line?.close();
    },
  };
}

/**
 * The approval helper's runner, made at each use: nothing about the helper is looked at before set-up or an Allow.
 * @param {boolean} packaged
 */
function lazyApprover(packaged) {
  const { approveHelperPath, createApprover } = require('./codePairApprove.cjs');
  const approver = () => createApprover({ helper: approveHelperPath({ packaged }) });
  return {
    enrol: (/** @type {string} */ hostId) => approver().enrol(hostId),
    commit: () => approver().commit(),
    abort: () => approver().abort(),
    reset: () => approver().reset(),
    approve: (/** @type {object} */ fields) => approver().approve(fields),
  };
}

/**
 * The service as the app makes it: the relay this install uses, the account's relay token, the "Allow connections"
 * consent, and the approval helper, which is looked for only when first used.
 * @param {{ app: { isPackaged?: boolean }, live?: Record<string, any> }} deps
 */
function codePairHostFor(deps) {
  const { relayUrl } = require('./relayPaths.cjs');
  const { noteIgnored } = require('../ignored.cjs');
  return createCodePairHost({
    // this Mac's own Host as the machine list shows it (electron/app/ipc/host.cjs sets live.localHostSocket)
    socketPath: () => deps.live?.localHostSocket?.() ?? '',
    relayUrl,
    relayToken: async () => (await deps.live?.mopilot?.relayToken?.()) ?? null,
    connections: () => deps.live?.remoteConsent?.enabled() === true,
    approver: lazyApprover(deps.app.isPackaged === true),
    report: (error) => noteIgnored('read a line from this Mac’s Host while pairing by code', error),
  });
}

module.exports = { createCodePairHost, codePairHostFor, lazyApprover, httpBase };
