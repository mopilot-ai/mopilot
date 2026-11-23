// A chat's subscribe reply on a remote Host connection (electron/host/remote.cjs): the Hello and the durable replay the Host writes before it answers, the live frames written after the Hello (held, never dropped: #3525), and what the subscribe returns from them.
const { MAX_QUEUE } = require('../../shared/host/stream.mjs');
const { HostError } = require('./interface.cjs');
const schema = require('../../shared/host/schema.mjs');
const { fillHistory } = require('./remoteHistory.cjs');
const { fanOut } = require('./remoteChannels.cjs');

/** What a durable stream frame is to a window: the patch at its revision. @param {{ item: object, promotes?: string }} f */
const patchOf = (f) => ({ item: f.item, ...(f.promotes === undefined ? {} : { promotes: f.promotes }) });

/** @typedef {{ hello: any, durables: any[], live: object[], bytes: number, liveCount: number, replayBytes: number, replayOverflow: boolean, overflow: boolean }} Collected */

/** The frames of each chat whose subscribe reply is still on its way. The Host answers a connection's requests in order, so the oldest subscribe of a chat collects. */
function createCollecting({ maxFrames = MAX_QUEUE, maxBytes = 16 * 1024 * 1024, maxReplayBytes = 16 * 1024 * 1024 } = {}) {
  /** @type {Map<string, Collected[]>} */
  const open = new Map();
  const transactions = new Map();
  return {
    /** One chat's complete subscribe plus history read owns its Hello until all pages settle. */
    serialize(chatId, work) {
      const prior = transactions.get(chatId) ?? Promise.resolve({ ok: true });
      const result = prior.then(work);
      // The caller keeps the original rejection; the ordering barrier retains a typed outcome for the next transaction.
      const settled = result.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      transactions.set(chatId, settled);
      const clear = () => {
        if (transactions.get(chatId) === settled) transactions.delete(chatId);
      };
      settled.then(clear);
      return result;
    },
    /** A subscribe of the chat is sent: its frames are collected until `close`. @param {string} chatId @returns {Collected} */
    open(chatId) {
      const got = { hello: null, durables: [], live: [], bytes: 0, liveCount: 0, replayBytes: 0, replayOverflow: false, overflow: false };
      open.set(chatId, [...(open.get(chatId) ?? []), got]);
      return got;
    },
    /** The subscribe that collected `got` settled; a later subscribe of the same chat keeps collecting. @param {string} chatId @param {Collected} got */
    close(chatId, got) {
      const rest = (open.get(chatId) ?? []).filter((g) => g !== got);
      if (rest.length) open.set(chatId, rest);
      else open.delete(chatId);
    },
    /** @param {string} chatId */
    has: (chatId) => open.has(chatId),
    /**
     * Takes a frame of a chat whose subscribe is on its way; false when there is none. A live frame before the Hello is in the Hello's unfinished text
     * already; one after it is not, and is handed over once the subscription is applied.
     * @param {string} chatId @param {any} frame
     */
    take(chatId, frame) {
      const got = open.get(chatId)?.[0];
      if (!got) return false;
      if (got.overflow) return true;
      if (frame.t === 'hello') {
        got.hello = frame;
        return true;
      }
      if (!got.hello && frame.t !== 'durable') return true;
      // A resume replays the committed prefix through hello.rev; those records are not live output.
      const replay = frame.t === 'durable' && (!got.hello || (got.hello.snapshot === null && frame.rev <= got.hello.rev));
      if (replay) {
        if (got.replayOverflow) return true;
        got.replayBytes += Buffer.byteLength(JSON.stringify(frame));
        if (got.replayBytes > maxReplayBytes) {
          got.replayOverflow = true;
          got.durables = [];
          return true;
        }
        got.durables.push(frame);
        return true;
      }
      got.bytes += Buffer.byteLength(JSON.stringify(frame));
      if (got.bytes > maxBytes || got.liveCount >= maxFrames) {
        got.overflow = true;
        got.hello = null;
        got.durables = [];
        got.live = [];
        return true;
      }
      got.liveCount++;
      if (frame.t === 'durable') got.durables.push(frame);
      else if (got.hello) got.live.push(frame);
      return true;
    },
    clear: () => open.clear(),
  };
}

/**
 * What a subscribe returns from what it collected: a Hello with a snapshot replaces what the window has; without one, the durables after `fromRev` are what it missed.
 * @param {string} chatId @param {Collected} got @param {number | undefined} fromRev
 */
function subscription(chatId, got, fromRev) {
  if (!got.hello) throw new HostError('invalid', 'The Host sent a subscription this app cannot read.');
  const { hello, live } = got;
  const generation = hello.generation;
  const newest = got.durables.reduce((n, f) => Math.max(n, f.rev), hello.rev);
  const inflight = hello.inFlightEphemeral;
  // the chat's title, goal and tasks as the Host holds them (null from a Host that names none)
  const chatState = hello.chatState ? { chatState: hello.chatState } : {};
  if (hello.snapshot)
    return { snapshot: { ...hello.snapshot, rev: hello.rev }, patches: null, newest, generation, inflight, ...chatState, live };
  const missed = got.durables.filter((f) => f.rev > /** @type {number} */ (fromRev));
  const patches = missed.map((f) => ({ chatId, rev: f.rev, patch: patchOf(f) }));
  return { snapshot: { rev: newest }, patches, newest, generation, inflight, ...chatState, live };
}

/** What a subscribe returns to its caller: the reply without the bookkeeping the connection keeps. @param {{ newest: number, live: object[] }} res */
const replyOf = ({ newest: _newest, live: _live, ...reply }) => reply;

/** Collect the subscription and all pinned history pages on the same live connection before releasing any buffered frames. */
async function readSubscription(options) {
  return options.collecting.serialize(options.chatId, () => readBaseline(options));
}
async function readBaseline(options) {
  const { chatId, fromRev, generation, epoch, needs, send, collecting, generations, history, current } = options;
  current();
  needs('chat.subscribe');
  const params = schema.parseParams('chat.subscribe', {
    chatId,
    epoch,
    ...(fromRev === undefined ? {} : { fromRev }),
    ...(generation ? { generation } : {}),
  });
  const got = collecting.open(chatId);
  const check = () => {
    current();
    if (got.overflow) throw new HostError('invalid', 'Too much live history arrived while opening this chat. Retry the chat.');
  };
  try {
    await send('chat.subscribe', params);
    check();
    if (history)
      await fillHistory(got.hello, (method, page) => {
        check();
        return send(method, schema.parseParams(method, { chatId, epoch, ...page }));
      });
    check();
  } finally {
    collecting.close(chatId, got);
  }
  if (got.replayOverflow) {
    if (fromRev === undefined) throw new HostError('invalid', 'The Host could not restore this chat history. Reopen the chat.');
    // Retry once without a resume cursor: the bounded snapshot/pager replaces this oversized replay.
    return readBaseline({ ...options, fromRev: undefined, generation: undefined });
  }
  const res = subscription(chatId, got, fromRev);
  if (res.generation) generations.set(chatId, res.generation);
  else generations.delete(chatId);
  return res;
}
/** The live frames a subscribe held, after what it returned was applied; a catch-up tells the chat's state first, as a frame. @param {Set<(p: { chatId: string, frame: object }) => void>} frameFns @param {string} chatId @param {object[]} live @param {object} [chatState] */
function handOver(frameFns, chatId, live, chatState) {
  for (const frame of chatState ? [{ t: 'state', patch: chatState }, ...live] : live) fanOut(frameFns, { chatId, frame }, 'a frame');
}

module.exports = { createCollecting, subscription, patchOf, replyOf, readSubscription, handOver };
