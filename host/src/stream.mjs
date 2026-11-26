// The Host side of the session stream: per chat one seq shared by a durable and an ephemeral lane, a durable tail for resuming, the ephemeral keys still in flight, and a bounded queue per subscription that closes the stream with `overflow` instead of growing (docs: design/host/index.html, package 2.3).
import crypto from 'node:crypto';
import { SessionJournalError } from './sessionJournal.mjs';
import { MAX_INFLIGHT_DELTAS, MAX_QUEUE } from '../../shared/host/stream.mjs';

/** A lane as the journal kept it, corrected with what a running Host holds when the journal knew of a held choice or the Host holds one the journal never heard of. @param {Record<string, unknown>} saved @param {Record<string, unknown> | undefined} held */
const laneOf = (saved, held) => ('pendingSwitch' in saved || held?.pendingSwitch ? { ...saved, ...held } : saved);

/** Durable frames kept per chat for a reconnect to replay. */
const KEEP_DURABLE = 500;

/**
 * @param {object} o
 * @param {(chatId: string) => { rev: number }} o.snapshot the chat's state now
 * @param {(chatId: string) => number} o.epoch the chat's epoch now
 * @param {number} [o.maxCachedChats] the inactive durable projection cache limit
 * @param {number} [o.maxQueue]
 * @param {string} [o.generation] names this hub's numbering: without a data dir revisions restart from 1 whenever the Host process does (with one the journal keeps the numbering across restarts), so a client keeps its resume point together with this
 * @param {(chatId: string) => Record<string, unknown>} [o.live] the part of a chat's lane only a running Host holds (a held choice of another agent): a lane this Host loads from its journal is corrected with it, so a restart never shows what it lost
 * @param {(chatId: string, frame: Record<string, any>) => void} [o.observe] told of each durable item and state patch once it is kept (the Host's chat index)
 * @param {ReturnType<typeof import('./sessionJournal.mjs').createSessionJournal>} [o.storage] the journal owned by this Host's data-dir lock
 */
export function createStreamHub({
  snapshot,
  epoch,
  maxQueue = MAX_QUEUE,
  generation = crypto.randomUUID(),
  storage,
  maxCachedChats = 128,
  live,
  observe,
}) {
  /** @type {Map<string, { generation: string, seq: number, tail: { seq: number, rev: number, item: object, promotes?: string }[], inflight: Map<string, { deltas: unknown[], truncated: boolean }>, state: Record<string, unknown>, subs: Set<ReturnType<typeof makeSub>> }>} */
  const chats = new Map();
  /** @param {string} chatId */
  const chat = (chatId) => {
    let c = chats.get(chatId);
    if (c) {
      chats.delete(chatId);
      chats.set(chatId, c);
    }
    if (!c && storage && chats.size >= maxCachedChats) {
      const victim = [...chats].find(([id, entry]) => !entry.subs.size && !entry.inflight.size && storage.evictable(id));
      if (!victim)
        throw new SessionJournalError(
          'This machine has too many active chats. Close active chats or delete unused chats, then retry.',
          'session_journal_busy',
        );
      chats.delete(victim[0]);
    }
    if (!c) {
      const saved = storage?.read(chatId);
      chats.set(
        chatId,
        (c = {
          generation: saved?.generation ?? generation,
          seq: saved?.seq ?? 0,
          tail: saved?.frames.slice(-KEEP_DURABLE) ?? [],
          inflight: new Map(),
          state: laneOf(saved?.state ?? {}, live?.(chatId)),
          subs: new Set(),
        }),
      );
    }
    return c;
  };

  /** @param {(frame: object) => boolean} send @param {(why: string) => void} close */
  function makeSub(send, close) {
    /** @type {object[]} */
    let queue = [];
    let paused = false;
    let closed = false;
    const sub = {
      /** Writes queued frames until `send` reports backpressure; returns after that or when the queue is empty. */
      flush() {
        while (!paused && !closed && queue.length > 0) if (send(/** @type {object} */ (queue.shift())) === false) paused = true;
      },
      /** The connection drained: write on. */
      resume() {
        paused = false;
        sub.flush();
      },
      /** @param {object} frame */
      push(frame) {
        if (closed) return;
        if (queue.length >= maxQueue) {
          // a consumer this far behind resubscribes from its rev; holding more would grow without bound
          queue = [];
          sub.end('overflow');
          return;
        }
        queue.push(frame);
        sub.flush();
      },
      /** @param {string} why */
      end(why) {
        if (closed) return;
        closed = true;
        queue = [];
        close(why);
      },
      get closed() {
        return closed;
      },
    };
    return sub;
  }

  /** @param {string} chatId @param {Record<string, unknown>} body the frame without its seq */
  function emit(chatId, body) {
    const c = chat(chatId);
    const frame = { ...body, seq: storage ? storage.next(chatId) : c.seq + 1 };
    if (body.t === 'durable') storage?.durable(chatId, /** @type {any} */ (frame));
    if (body.t === 'state') {
      const { promptSuggestion, ...durable } = /** @type {Record<string, unknown>} */ (body.patch);
      if (Object.keys(durable).length) storage?.state(chatId, durable);
    }
    c.seq = frame.seq;
    // Reentrant subscribers must see the committed projection, not a retired ephemeral key or stale state.
    if (body.t === 'durable') {
      if (body.promotes !== undefined) c.inflight.delete(/** @type {string} */ (body.promotes));
      c.tail.push(/** @type {any} */ (frame));
      if (c.tail.length > KEEP_DURABLE) c.tail.splice(0, c.tail.length - KEEP_DURABLE);
    }
    if (body.t === 'state') c.state = { ...c.state, .../** @type {object} */ (body.patch) };
    if (body.t === 'durable' || body.t === 'state') observe?.(chatId, frame);
    for (const s of [...c.subs]) {
      s.push(frame);
      if (s.closed) c.subs.delete(s);
    }
    return frame;
  }

  return {
    active(chatId) {
      const c = chats.get(chatId);
      return !!c && (c.subs.size > 0 || c.inflight.size > 0);
    },
    remove(chatId) {
      for (const sub of [...(chats.get(chatId)?.subs ?? [])]) sub.end('session_journal_deleted');
      chats.delete(chatId);
    },
    /** A finished item (what the chat log keeps), at `rev`. `promotes` names the in-flight key it replaces. @param {string} chatId @param {{ rev: number, item: object, promotes?: string }} d */
    durable(chatId, { rev, item, promotes }) {
      const frame = emit(chatId, { t: 'durable', rev, item, ...(promotes === undefined ? {} : { promotes }) });
      return frame.seq;
    },
    /** A token or tool-output delta of an unfinished item: shown live, never replayed after a reconnect. @param {string} chatId @param {string} key @param {unknown} delta */
    delta(chatId, key, delta) {
      const c = chat(chatId);
      const run = c.inflight.get(key) ?? { deltas: [], truncated: false };
      run.deltas.push(delta);
      if (run.deltas.length > MAX_INFLIGHT_DELTAS) {
        run.deltas.splice(0, run.deltas.length - MAX_INFLIGHT_DELTAS);
        run.truncated = true;
      }
      c.inflight.set(key, run);
      return emit(chatId, { t: 'delta', key, delta }).seq;
    },
    /** The chat's state changed (title, goal, tasks): the newest of each is kept for a Hello, and told live. A later subscriber is given it whole, so a reconnect never replays it. @param {string} chatId @param {Record<string, unknown>} patch */
    state(chatId, patch) {
      return emit(chatId, { t: 'state', patch }).seq;
    },
    /** The chat's state lane as kept. @param {string} chatId */
    current: (chatId) => ({ ...chat(chatId).state }),
    /** An in-flight item that will not finish (cancelled): its key goes without a durable. @param {string} chatId @param {string} key */
    retract(chatId, key) {
      chat(chatId).inflight.delete(key);
      return emit(chatId, { t: 'retract', key }).seq;
    },
    /**
     * Opens a subscription. The Hello is the first frame: with `fromRev` and a tail that holds every later revision it carries no snapshot and the missed durables follow; otherwise it carries the snapshot alone. Live frames follow either way.
     * `generation` is the numbering `fromRev` was counted in: a client that names another (this Host restarted since) is given the snapshot.
     * @param {string} chatId @param {{ fromRev?: number, generation?: string, send: (frame: object) => boolean, close: (why: string) => void }} o
     */
    subscribe(chatId, { fromRev, generation: theirs, send, close }) {
      const c = chat(chatId);
      const snap = snapshot(chatId);
      const sameNumbering = theirs === undefined || theirs === c.generation;
      const missed = sameNumbering && typeof fromRev === 'number' && fromRev <= snap.rev ? c.tail.filter((f) => f.rev > fromRev) : null;
      // the tail resumes a client only if it holds one durable for each revision it missed
      const resumes =
        !('storageError' in snap) &&
        missed !== null &&
        new Set(missed.map((f) => f.rev)).size === snap.rev - /** @type {number} */ (fromRev);
      const sub = makeSub(send, close);
      sub.push({
        t: 'hello',
        seq: c.seq,
        rev: snap.rev,
        epoch: epoch(chatId),
        generation: c.generation,
        snapshot: resumes ? null : snap,
        // (only when there is any: a Hello of a chat with none is what it always was)
        ...(Object.keys(c.state).length ? { chatState: { ...c.state } } : {}),
        inFlightEphemeral: [...c.inflight].map(([key, run]) => ({ key, deltas: run.deltas, truncated: run.truncated })),
      });
      if (resumes) for (const f of /** @type {NonNullable<typeof missed>} */ (missed)) sub.push({ t: 'durable', ...f });
      if (!sub.closed) c.subs.add(sub);
      return { resume: sub.resume, unsubscribe: () => (c.subs.delete(sub), sub.end('unsubscribed')) };
    },
    /** Closes every subscription of a chat the Host no longer serves. @param {string} chatId @param {string} why */
    close(chatId, why) {
      for (const s of [...(chats.get(chatId)?.subs ?? [])]) s.end(why);
      chats.delete(chatId);
    },
  };
}
