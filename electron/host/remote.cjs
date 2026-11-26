// The remote Host: the interface of electron/host/interface.cjs as requests over a framed stream through an SSH tunnel; it never queues a call while the tunnel is down, it refuses it.
const crypto = require('node:crypto');
const net = require('node:net');
const { HostError, HostUnreachableError, assertHost } = require('./interface.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const frames = require('../../shared/host/frames.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { authenticate } = require('./pairingClient.cjs');
const { userError } = require('../../shared/userError.mjs');
const schema = require('../../shared/host/schema.mjs');
const stream = require('../../shared/host/stream.mjs');
const { chatCalls } = require('./remoteChatCalls.cjs');
const { signinCalls } = require('./remoteSignin.cjs');
const { scheduleCalls } = require('./remoteSchedules.cjs');
const { policyCalls } = require('./remotePolicy.cjs');
const { installCalls } = require('./remoteInstallCalls.cjs');
const { createChannels, fanOut } = require('./remoteChannels.cjs');
const { createTrust } = require('./remoteTrust.cjs');
const { createCatchUpRetries } = require('./catchUpRetries.cjs');
const { createCollecting, readSubscription, patchOf, replyOf, handOver } = require('./remoteSubscribe.cjs');

/** Without a frame from the Host for this many heartbeats, the connection counts as dead. */
const SILENT_BEATS = 2;

/** @param {unknown} n */
const isRev = (n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0;
/**
 * @param {object} o
 * @param {string} o.id the Host's id in the registry
 * @param {ReturnType<typeof import('./sshTunnel.cjs').createTunnel>} o.tunnel
 * @param {(socketPath: string) => import('node:net').Socket} [o.connect]
 * @param {number} [o.heartbeatMs] how often a ping proves the Host still answers
 * @param {number} [o.helloMs] how long a new connection may take to answer its first ping
 * @param {(chatId: string) => number} [o.epochOf] the epoch the ownership side map holds for the chat (every chat request carries it)
 * @param {() => object[]} [o.movedOf] the chats the app continued without this Host (a lost-host continue): its hello tells the Host, which then poisons its copies (3.1)
 * @param {(reply: unknown) => void} [o.onHello] the Host's answer about those chats, for the app to read their tails
 * @param {(() => ReturnType<typeof import('./pairingClient.cjs').loadIdentity>) | null} [o.identity] this install's key (pairingClient.cjs): every new connection proves it with `host.auth` before anything else, because a Host serves a paired client only; null: the Host has no pairing
 * @param {() => string} [o.mintKey] a new idempotency key; a caller that retries a request passes its own `opts.key` so the retry is the same request
 */
function createRemoteHost({
  id,
  tunnel,
  connect = (p) => net.connect(p),
  heartbeatMs = 15_000,
  helloMs = 5000,
  epochOf = () => 0,
  movedOf = () => [],
  onHello = () => undefined,
  identity = null,
  mintKey = () => crypto.randomUUID(),
}) {
  let disposed = false;
  let nextId = 1;
  /** @type {ReturnType<typeof tunnel.acquire> | null} */
  let lease = null;
  /** @type {{ socket: import('node:net').Socket, decoder: ReturnType<typeof frames.createDecoder> } | null} */
  let conn = null;
  let ready = false;
  let lastSeen = 0;
  /** @type {any} */
  let beat = null;
  /** @type {any} */
  let helloTimer = null;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  /** The last rev delivered for each chat the window follows. @type {Map<string, number>} */
  const subs = new Map();
  /** The numbering (the Host's stream generation) each followed chat's last rev was counted in. @type {Map<string, string>} */
  const generations = new Map();
  /** The frames of each chat whose subscribe reply is still on its way (remoteSubscribe.cjs). */
  const collecting = createCollecting();
  /** What the Host declared in its hello: every surface false until it has answered (an older Host declares none). */
  let declared = schema.capabilitiesOf(null);
  /** What this connection and the Host agreed on, or null (an older Host, or none that could agree: `refusal` says why). @type {{ minor: number, features: string[] } | null} */
  let agreed = null;
  /** @type {Error | null} */
  let refusal = null;
  /** Why this connection's Host did not accept this app as a paired client, or null. Every call that needs the Host's trust says it. @type {Error | null} */
  let unpaired = null;
  /** @type {Set<string>} */
  const catching = new Set();
  /** @type {Set<(p: { chatId: string, rev: number, patch: object }) => void>} */
  const patchFns = new Set();
  /** @type {Set<(p: { chatId: string, snapshot: object, generation: string }) => void>} */
  const resyncFns = new Set();
  /** The text of unfinished items the Host holds, after each catch-up. @type {Set<(p: { chatId: string, inflight: { key: string, deltas: unknown[], truncated: boolean }[] }) => void>} */
  const inflightFns = new Set();
  /** Ephemeral frames (deltas, retracts) as they arrive: shown live, never replayed. @type {Set<(p: { chatId: string, frame: object }) => void>} */
  const frameFns = new Set();
  /** @type {Set<(p: { chatId: string, reason: string }) => void>} */
  const closedFns = new Set();
  /** @type {Set<(s: 'online' | 'connecting' | 'offline') => void>} */
  const stateFns = new Set();
  /** Told after every proof of this app's key on a connection: the Host's refusal, or null once it was accepted (machines' rows, proofWatch.cjs). @type {Set<(e: Error | null) => void>} */
  const refusedFns = new Set();
  /** @type {(() => void) | null} */
  let offTunnel = null;
  /** @type {Set<{ resolve: () => void, reject: (e: Error) => void }>} */
  const connecting = new Set();

  const retries = createCatchUpRetries({ subs, closedFns, disposed: () => disposed, again: (chatId) => catchUp(chatId) });
  const state = () => (disposed ? 'offline' : ready ? 'online' : tunnel.state === 'online' ? 'connecting' : tunnel.state);
  let announced = state();
  const announce = () => {
    const now = state();
    if (now === announced) return;
    announced = now;
    fanOut(stateFns, now, 'a state change');
  };
  // a call refused up front never left the app: a caller can tell it from one whose answer was lost
  const refuse = () =>
    Object.assign(new HostUnreachableError(id, tunnel.state === 'online' ? 'connecting' : tunnel.state), { notSent: true });
  const live = () => {
    if (disposed) throw new HostError('disposed', 'This Host was disposed.');
  };
  // a call that needs the Host's trust asks once more when its "unknown client" answer is remembered (remoteTrust.cjs)
  const { trusted, trustedRequest } = createTrust({
    unpaired: () => unpaired,
    again: () => agree(send, true),
    live,
    ready: () => ready,
    refuse,
    request,
    gate,
  });
  const channels = createChannels({ needs, request: trustedRequest, epochOf, live });

  /** The connection is gone: everything waiting on it fails now, and the tunnel is taken down when it is what broke. @param {string} why @param {boolean} breakTunnel */
  function drop(why, breakTunnel) {
    const c = conn;
    conn = null;
    ready = false;
    agreed = null;
    declared = schema.capabilitiesOf(null);
    refusal = null;
    clock.clearInterval(beat);
    clock.clearTimeout(helloTimer);
    c?.socket.destroy();
    const err = new HostUnreachableError(id, why);
    for (const [key, p] of [...pending]) {
      pending.delete(key);
      p.reject(err);
    }
    announce();
    if (c && breakTunnel && !disposed) tunnel.fail(why);
  }

  /** @param {string} method @param {object} [params] @returns {Promise<any>} */
  function send(method, params) {
    // every caller checked the connection in this same turn
    const c = /** @type {NonNullable<typeof conn>} */ (conn);
    const key = nextId++;
    // encoded first: a request too large for a frame fails here and leaves nothing pending
    const bytes = frames.encodeControl({ id: key, method, params });
    return new Promise((resolve, reject) => {
      pending.set(key, { resolve, reject });
      c.socket.write(bytes);
    });
  }
  /** A call a window makes: refused unless the connection is up (queueing while offline is not this layer's job). @param {string} method @param {object} [params] */
  async function request(method, params) {
    live();
    if (!ready) throw refuse();
    return send(method, params);
  }
  /** @param {string} chatId @param {number} rev @param {object} patch */
  const deliver = (chatId, rev, patch) => {
    // a chat the window does not follow keeps no baseline
    if (subs.has(chatId)) subs.set(chatId, rev);
    fanOut(patchFns, { chatId, rev, patch }, 'a patch');
  };

  /** The chat's state after `last`: the patches it missed, or its snapshot when the Host lost some. @param {string} chatId */
  async function catchUp(chatId) {
    if (catching.has(chatId) || !subs.has(chatId)) return;
    catching.add(chatId);
    try {
      const last = /** @type {number} */ (subs.get(chatId));
      const res = await subscribeRaw(chatId, last, generations.get(chatId));
      if (Array.isArray(res.patches)) {
        for (const p of res.patches) if (isRev(p?.rev) && p.rev > /** @type {number} */ (subs.get(chatId))) deliver(chatId, p.rev, p.patch);
      } else {
        subs.set(chatId, res.snapshot.rev);
        fanOut(resyncFns, { chatId, snapshot: res.snapshot, generation: res.generation }, 'a resync');
      }
      fanOut(inflightFns, { chatId, inflight: res.inflight }, 'unfinished text');
      handOver(frameFns, chatId, res.live, res.chatState);
      retries.done(chatId);
    } catch (e) {
      retries.failed(chatId, e);
    } finally {
      catching.delete(chatId);
    }
  }

  /** Subscribes and reads the Hello (and the durable replay behind it) that the Host writes before it answers. @param {string} chatId @param {number} [fromRev] @param {string} [generation] the numbering `fromRev` was counted in */
  async function subscribeRaw(chatId, fromRev, generation) {
    await trusted();
    const serving = conn;
    return readSubscription({
      chatId,
      fromRev,
      generation,
      epoch: epochOf(chatId),
      needs,
      send,
      collecting,
      generations,
      history: agreed?.features.includes('historyPages'),
      current: () => {
        if (conn !== serving || !ready) throw new HostUnreachableError(id, 'The connection changed while reading history.');
      },
    });
  }

  /** Refuses a call the agreed protocol does not allow: an older Host, a version too far apart, or a safety feature it lacks. @param {string} method @param {object} [params] */
  function needs(method, params) {
    live();
    // a call while the connection is down says so; only a connection that is up can have failed to agree
    if (!ready) throw refuse();
    // not refused here: trustedRequest() asks the Host once more first, and gates the call itself once the answer changed
    if (unpaired) return;
    gate(method, params);
  }
  /** @param {string} method @param {object} [params] */
  function gate(method, params) {
    if (!agreed) throw /** @type {Error} */ (refusal);
    try {
      schema.requireFeatures(method, agreed, params);
    } catch (e) {
      throw gateError(/** @type {any} */ (e));
    }
  }

  /** A request that names no chat (status, sign-in): parsed by the shared schema, and sent only once the Host and the app agreed on a version. @param {string} method @param {object} params */
  async function control(method, params) {
    needs(method, params);
    return trustedRequest(method, schema.parseParams(method, params));
  }

  /** @param {{ code: string, message: string, missing?: string[] }} g */
  function gateError(g) {
    return Object.assign(new HostError(/** @type {any} */ (g.code), g.message), { missing: g.missing ?? [] });
  }

  /** A frame of a chat's stream. @param {Record<string, any>} msg */
  function onFrame(msg) {
    const chatId = msg.chatId;
    if (typeof chatId !== 'string') return;
    let frame;
    try {
      frame = stream.parseFrame(msg.frame);
    } catch {
      // a frame this app cannot read means the stream is no longer trusted: start again from the last rev (a subscribe still waiting for its Hello fails on its own)
      return collecting.has(chatId) ? undefined : void catchUp(chatId);
    }
    if (collecting.take(chatId, frame)) return;
    if (frame.t === 'hello') return;
    if (frame.t !== 'durable') return fanOut(frameFns, { chatId, frame }, 'a frame');
    const last = subs.get(chatId);
    if (last === undefined) return deliver(chatId, frame.rev, patchOf(frame));
    if (frame.rev <= last) return;
    // a revision skipped: replay from the last rev the window saw instead of delivering out of order
    if (frame.rev > last + 1) return void catchUp(chatId);
    deliver(chatId, frame.rev, patchOf(frame));
  }

  /** @param {Record<string, any>} msg */
  function onControl(msg) {
    if (msg.event === 'frame') return onFrame(msg);
    if (channels.route(msg)) return;
    if (msg.event === 'closed') {
      const { chatId, reason } = msg;
      if (typeof chatId !== 'string') return;
      // a consumer that fell behind resubscribes from its rev; any other close means the Host no longer serves the chat to it
      if (reason === 'overflow') return void catchUp(chatId);
      subs.delete(chatId);
      return fanOut(closedFns, { chatId, reason: String(reason) }, 'a close');
    }
    const waiter = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
    if (!waiter) return;
    pending.delete(/** @type {number} */ (msg.id));
    if (msg.error !== undefined) {
      const e = msg.error;
      // an older Host sends the message alone
      const code = typeof e?.code === 'string' ? e.code : typeof msg.code === 'string' ? msg.code : 'host_error';
      const err = Object.assign(
        new HostError(/** @type {any} */ (code), typeof e === 'string' ? e : String(e?.message ?? 'The Host failed.')),
        {
          // a refusal carries what the caller needs to act on it: the chat's current epoch, the features the Host lacks, and that the Host answered with it (`fromHost`), as against this app's own errors
          ...(Number.isSafeInteger(msg.current) ? { current: msg.current } : {}),
          ...(Array.isArray(msg.missing) ? { missing: msg.missing } : {}),
          ...(msg.details && typeof msg.details === 'object' ? { details: msg.details } : {}),
          fromHost: true,
        },
      );
      return waiter.reject(err);
    }
    if (!('result' in msg)) return waiter.reject(new HostError('invalid', 'The Host sent a reply with no result.'));
    waiter.resolve(msg.result);
  }

  /** Pings, then `host.hello`: what both ends speak. A Host that cannot agree stays reachable, but its chat requests are refused (needs()). @param {typeof send} ask @param {boolean} [again] the same connection, asking again: the Host's answer about moved chats was already acted on */
  async function agree(ask, again = false) {
    await ask('ping');
    let continued;
    unpaired = null;
    if (again) refusal = null;
    if (identity) {
      try {
        await authenticate(ask, identity());
      } catch (e) {
        // a dropped connection fails the whole attach; any other answer (not paired, a wrong key, a key that cannot be read) is this Host's, and chat requests are refused with it
        if (/** @type {any} */ (e)?.code === 'host_unreachable') throw e;
        unpaired = e instanceof HostError ? e : new HostError(/** @type {any} */ ('key_unreadable'), userError(e));
      }
      fanOut(refusedFns, unpaired, 'a proof answer');
    }
    try {
      const reply = await ask('host.hello', { ...schema.helloParams(), moved: movedOf() });
      const theirs = schema.parseParams('host.hello', reply);
      agreed = schema.negotiate(schema.helloParams(), theirs);
      declared = theirs.capabilities;
      continued = reply?.continued;
    } catch (e) {
      // a dropped connection fails the whole attach; any other failure is this Host's answer
      if (/** @type {any} */ (e)?.code === 'host_unreachable') throw e;
      refusal = e instanceof HostError ? e : gateError(/** @type {any} */ (e));
    }
    // what the Host says about the chats the app moved away is the app's to act on; its failure is not this connection's
    if (continued && !again) {
      try {
        onHello(continued);
      } catch (e) {
        noteIgnored('read the Host’s answer about continued chats', e);
      }
    }
  }

  function attach() {
    if (disposed || conn || !lease || tunnel.state !== 'online') return;
    const socket = connect(lease.socketPath);
    const decoder = frames.createDecoder();
    const mine = { socket, decoder };
    conn = mine;
    lastSeen = clock.now();
    const gone = (/** @type {string} */ why) => conn === mine && drop(why, true);
    socket.on('error', (e) => gone(e.message));
    socket.on('close', () => gone(decoder.pending() > 0 ? 'The connection ended in the middle of a frame.' : 'The connection closed.'));
    socket.on('data', (chunk) => {
      if (conn !== mine) return;
      lastSeen = clock.now();
      try {
        for (const f of decoder.push(chunk)) if (f.kind === 'control') onControl(f.message);
      } catch (e) {
        gone(`The Host sent a bad frame: ${/** @type {Error} */ (e).message}`);
      }
    });
    helloTimer = clock.setTimeout(() => gone('The host did not answer.'), helloMs);
    socket.once('connect', () => {
      agree(send).then(
        () => {
          clock.clearTimeout(helloTimer);
          ready = true;
          beat = clock.setInterval(() => {
            if (clock.now() - lastSeen > heartbeatMs * SILENT_BEATS) return gone('The host stopped answering.');
            socket.write(frames.encodeControl({ method: 'ping' }));
          }, heartbeatMs);
          announce();
          for (const w of [...connecting]) w.resolve();
          for (const chatId of [...subs.keys()]) void catchUp(chatId);
        },
        () => {
          // the connection dropped before the Host answered; drop() already told everyone
        },
      );
    });
  }
  return assertHost({
    hostInfo: () => ({ id, kind: 'ssh', state: state(), capabilities: declared }),
    /** Any versioned request (the continue methods), checked against what both ends agreed: the app's channel to this Host. @param {string} method @param {object} params */
    async call(method, params) {
      needs(method, params);
      return trustedRequest(method, schema.parseParams(method, params));
    },
    chats: async () => {
      const res = await request('chats');
      if (!Array.isArray(res) || res.some((c) => typeof c !== 'string'))
        throw new HostError('invalid', 'The Host sent a chat list this app cannot read.');
      return res;
    },
    // a chat's requests: a message, the first message, Stop, a permission card's answer, a permission mode (electron/host/remoteChatCalls.cjs); `negotiated`: a hello was answered (before it, after a drop and after a refusal nothing is known of what the Host speaks)
    ...chatCalls({ needs, request: trustedRequest, epochOf, mintKey, speaks: (feature) => agreed?.features.includes(feature) === true }),
    negotiated: () => agreed !== null,
    /** The Host's own status, read now (not the registry's last heartbeat): its harnesses and whether each is signed in. `signIn` (repository hosts) adds `gitSignIn`: whether the machine's git can sign in to each, which a heartbeat never asks. */
    status: (/** @type {{ signIn?: string[] }} */ opts) => control('host.status', opts?.signIn ? { signIn: opts.signIn } : {}),
    // sign-in and sign-out (remoteSignin.cjs)
    ...signinCalls(control),
    ...scheduleCalls(control),
    ...policyCalls(control),
    // installing a missing agent (remoteInstallCalls.cjs)
    ...installCalls(control),
    /**
     * The chat's state now plus the patches since `fromRev`, as the local Host returns them, over the wire. `generation` is the numbering `fromRev` was counted in
     * (the one a previous subscribe returned): a Host that restarted since answers with its snapshot, never with patches of another numbering.
     * @param {string} chatId @param {number} [fromRev] @param {string} [generation]
     */
    async subscribe(chatId, fromRev, generation) {
      live();
      if (typeof chatId !== 'string' || !chatId) throw new HostError('invalid', 'A chat id is required.');
      if (!ready) throw refuse();
      const res = await subscribeRaw(chatId, fromRev, generation);
      subs.set(chatId, res.snapshot.rev);
      // a durable that raced the reply and is newer than the snapshot: catch up from the snapshot
      if (res.patches === null && res.newest > res.snapshot.rev) void catchUp(chatId);
      // the caller applies what is returned before what it hears next (remoteChats.cjs serializes both)
      handOver(frameFns, chatId, res.live);
      return replyOf(res);
    },
    // the chat's tabs in the Host's browser, and the tool relay (electron/host/remoteChannels.cjs)
    browser: channels.browser,
    desktop: channels.desktop,
    tools: channels.tools,
    events: {
      /** @param {(p: { chatId: string, rev: number, patch: object }) => void} fn */
      onPatch(fn) {
        live();
        patchFns.add(fn);
        return () => void patchFns.delete(fn);
      },
      /** Live deltas and retracts of unfinished items; never replayed after a reconnect. @param {(p: { chatId: string, frame: object }) => void} fn */
      onFrame(fn) {
        live();
        frameFns.add(fn);
        return () => void frameFns.delete(fn);
      },
      /** The Host ended a chat's stream for a reason other than falling behind. @param {(p: { chatId: string, reason: string }) => void} fn */
      onClosed(fn) {
        live();
        closedFns.add(fn);
        return () => void closedFns.delete(fn);
      },
      /** The Host lost patches the window missed: the chat's snapshot alone, and the numbering it counts in. @param {(p: { chatId: string, snapshot: object, generation: string }) => void} fn */
      onResync(fn) {
        live();
        resyncFns.add(fn);
        return () => void resyncFns.delete(fn);
      },
      /** After a catch-up, the unfinished items' text so far (never replayed as frames): what a follower that saw part of it still lacks. @param {(p: { chatId: string, inflight: { key: string, deltas: unknown[], truncated: boolean }[] }) => void} fn */
      onInflight(fn) {
        live();
        inflightFns.add(fn);
        return () => void inflightFns.delete(fn);
      },
    },
    /** online once the Host answers, connecting while the tunnel comes up, offline when it is down or waiting to retry. */
    state,
    refused: () => unpaired,
    onRefused: (/** @type {(e: Error | null) => void} */ fn) => (refusedFns.add(fn), () => void refusedFns.delete(fn)),
    /** @param {(s: 'online' | 'connecting' | 'offline') => void} fn */
    onState(fn) {
      stateFns.add(fn);
      return () => void stateFns.delete(fn);
    },
    /** Takes a share of the tunnel and resolves when the Host answers; rejects `host_unreachable` when disposed first. */
    connect() {
      live();
      if (!lease) {
        lease = tunnel.acquire();
        offTunnel = tunnel.onState((s) => {
          if (s === 'online') attach();
          else drop(`The tunnel is ${s}.`, false);
          announce();
        });
        attach();
      }
      return ready
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const w = {
              resolve: () => (connecting.delete(w), resolve(undefined)),
              reject: (/** @type {Error} */ e) => (connecting.delete(w), reject(e)),
            };
            connecting.add(w);
          });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offTunnel?.();
      drop('This Host was disposed.', false);
      const err = new HostUnreachableError(id, 'This Host was disposed.');
      for (const w of [...connecting]) w.reject(err);
      lease?.release();
      patchFns.clear();
      resyncFns.clear();
      inflightFns.clear();
      frameFns.clear();
      closedFns.clear();
      channels.clear();
      collecting.clear();
      generations.clear();
      stateFns.clear();
      refusedFns.clear();
      subs.clear();
    },
  });
}

module.exports = { createRemoteHost, HostUnreachableError };
