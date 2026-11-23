// The phone's follow of chats on Hosts it reaches directly (#2709, X4): one subscription per chat, the Host's frames folded into the Thread's
// snapshot and feed events (shared/host/fold.mjs, threadRows.mjs), and the sends, stops and starts that go to the Host itself, each with a key
// that is the same on every retry, so the outbox's one message is one message however many paths it tried.
import { appChatId, hostChatId } from '../host/chatIds.mjs';
import { parseFrame } from '../host/stream.mjs';
import { createFold, eventOf } from '../host/fold.mjs';
import { createThreadRows } from '../host/threadRows.mjs';
import { sha256Hex } from './sha256.mjs';
import { assertTaken } from '../host/startRefusal.mjs';

/** The events that change which cards a machine waits on. */
const CARD_EVENTS = new Set(['permission', 'question', 'permissionCancelled', 'turnEnd']);

/** The most pages a history fill reads: a Host that never ends a cursor cannot hold the phone. */
const MAX_PAGES = 400;

/** What a write's reply carries: the Host answers `{ replayed, result }`, and the result is what the effect returned. @param {any} reply */
const resultOf = (reply) => (reply && typeof reply === 'object' && 'result' in reply ? reply.result : reply);

/** The key of one send: the same on every try of the same message, even after the app restarted. @param {string} kind @param {string} id */
export const keyOf = (kind, id) => `phone-${sha256Hex(`${kind}\n${id}`).slice(0, 24)}`;

/**
 * @param {object} o
 * @param {(machineId: string) => Promise<ReturnType<typeof import('./phoneHost.mjs').createPhoneHost>>} o.host the machine's open session
 * @param {(machineId: string) => string | null} o.hostKeyOf the machine's Host key (the scope of its pictures)
 * @param {(chatId: string, event: any) => void} o.emit a feed event of a followed chat
 * @param {(machineId: string) => void} [o.cardsMoved] a card of the machine was raised, withdrawn or closed by its turn ending: the machine's waiting cards are read again
 * @param {() => number} [o.now]
 */
export function createPhoneChats({ host, hostKeyOf, emit, cardsMoved, now = Date.now }) {
  /** @type {Map<string, any>} */
  const chats = new Map();

  /** @param {string} chatId @param {string} machineId */
  function chatOf(chatId, machineId) {
    let c = chats.get(chatId);
    if (!c || c.machineId !== machineId) {
      c = {
        machineId,
        epoch: 0,
        generation: '',
        rev: 0,
        feedSeq: 0,
        following: false,
        unavailable: false,
        /** @type {any[] | null} */ held: null,
        ephemeral: new Map(),
        fold: createFold({ hostId: hostKeyOf(machineId) ?? machineId, now }),
        rows: createThreadRows(),
      };
      chats.set(chatId, c);
    }
    return c;
  }

  /** Runs a request with the chat's epoch; a stale one is retried once with the epoch the Host names. @param {any} c @param {(epoch: number) => Promise<any>} call */
  async function withEpoch(c, call) {
    try {
      return await call(c.epoch);
    } catch (e) {
      const current = /** @type {any} */ (e)?.code === 'stale_epoch' ? /** @type {any} */ (e).details?.current : undefined;
      if (!Number.isSafeInteger(current)) throw e;
      c.epoch = current;
      return call(current);
    }
  }

  /** Tells the Thread its picture of the chat is out of date: it reads the chat again. @param {string} chatId @param {any} c */
  function stale(chatId, c) {
    emit(chatId, { ev: 'turn.state', status: null, turnId: null, live: false, feedSeq: ++c.feedSeq });
  }

  /** Applies one stream item of the Host; returns the feed events it makes. @param {any} c @param {any} item */
  function ingest(c, item) {
    const out = c.fold.push(item);
    // the agent a chat runs on is the one its last settled switch moved it to
    for (const rec of out.records) if (rec.t === 'switch' && rec.to) c.agent = rec.to;
    return out.records.flatMap((/** @type {any} */ rec) => c.rows.push(rec));
  }

  /** @param {string} chatId @param {any} c @param {any} frame */
  function apply(chatId, c, frame) {
    if (frame.t === 'hello') {
      c.epoch = frame.epoch;
      c.generation = frame.generation;
      c.rev = frame.rev;
      c.ephemeral.clear();
      for (const e of frame.inFlightEphemeral)
        c.ephemeral.set(e.key, e.deltas.map((/** @type {any} */ d) => String(d?.text ?? '')).join(''));
      return [];
    }
    if (frame.t === 'durable') {
      if (frame.rev <= c.rev) return [];
      if (frame.rev > c.rev + 1) {
        c.unavailable = true;
        return null;
      }
      c.rev = frame.rev;
      const had = frame.promotes !== undefined && c.ephemeral.delete(frame.promotes);
      const events = ingest(c, frame.item);
      // the cards are not in the stream: a request that waits, one that was withdrawn and a turn that ended all change what the Host reports as waiting
      if (CARD_EVENTS.has(eventOf(frame.item)?.kind)) cardsMoved?.(c.machineId);
      return had ? [...events, { ev: 'turn.state', status: null, turnId: null, live: false }] : events;
    }
    if (frame.t === 'delta') {
      const text = typeof frame.delta?.text === 'string' ? frame.delta.text : '';
      if (!text) return [];
      const id = `e-${frame.key}`;
      const first = !c.ephemeral.has(frame.key);
      c.ephemeral.set(frame.key, (c.ephemeral.get(frame.key) ?? '') + text);
      return first
        ? [{ ev: 'items.append', items: [{ id, type: 'agentMessage', text }] }]
        : [{ ev: 'items.delta', itemId: id, field: 'text', text }];
    }
    if (frame.t === 'retract') return c.ephemeral.delete(frame.key) ? [{ ev: 'turn.state', status: null, turnId: null, live: false }] : [];
    return [];
  }

  /** @param {string} chatId @param {any} c @param {any} raw */
  function onFrame(chatId, c, raw) {
    let frame;
    try {
      frame = parseFrame(raw);
    } catch {
      c.unavailable = true;
      if (c.following) stale(chatId, c);
      return;
    }
    if (c.held) return void c.held.push(frame);
    const events = apply(chatId, c, frame);
    if (events === null) return void (c.following && stale(chatId, c));
    for (const ev of events) emit(chatId, { ...ev, feedSeq: ++c.feedSeq });
  }

  /** The whole log of a chat whose hello was clipped, page by page. @param {any} session @param {any} c @param {string} chatId @param {any} hello */
  async function fill(session, c, chatId, hello) {
    /** @type {any[]} */
    const items = [];
    let cursor = { index: 0, offset: 0 };
    for (let n = 0; n < MAX_PAGES; n++) {
      const page = await session.history({
        chatId: hostChatId(chatId),
        epoch: c.epoch,
        generation: hello.generation,
        rev: hello.rev,
        ...cursor,
      });
      if (page?.generation !== hello.generation || page.rev !== hello.rev || typeof page.chunk !== 'string') throw new Error('invalid');
      for (const line of page.chunk.split('\n')) if (line) items.push(JSON.parse(line));
      if (!page.next) return items;
      cursor = page.next;
    }
    throw new Error('invalid');
  }

  return {
    /**
     * `chat.follow`: subscribes and answers with the snapshot the Thread reads. Frames that arrive on the way are held, then applied.
     * @param {string} machineId @param {string} chatId
     */
    async follow(machineId, chatId) {
      const session = await host(machineId);
      const c = chatOf(chatId, machineId);
      c.following = false;
      c.unavailable = false;
      c.fold = createFold({ hostId: hostKeyOf(machineId) ?? machineId, now });
      c.rows = createThreadRows();
      c.rev = 0;
      c.held = [];
      c.pump = (/** @type {any} */ raw) => onFrame(chatId, c, raw);
      try {
        await withEpoch(c, (epoch) => session.subscribe({ chatId: hostChatId(chatId), epoch }));
        const held = c.held;
        c.held = null;
        const hello = held.find((f) => f.t === 'hello');
        if (!hello) throw new Error('The machine sent no state for this chat.');
        apply(chatId, c, hello);
        let items = hello.snapshot?.items ?? [];
        if (hello.snapshot?.paged) items = await fill(session, c, chatId, hello);
        for (const item of items) ingest(c, item);
        // what came after the hello is part of the picture the snapshot is made from
        for (const f of held)
          if (f !== hello && apply(chatId, c, f) === null) throw new Error('The chat changed while it was read. Try again.');
      } catch (e) {
        c.held = null;
        throw e;
      }
      const snap = c.rows.snapshot();
      const live = [...c.ephemeral].map(([key, text]) => ({ id: `e-${key}`, type: 'agentMessage', text }));
      c.following = true;
      return {
        chatId,
        rev: c.rev,
        feedSeq: c.feedSeq,
        session: { turn: snap.turn },
        items: [...snap.items, ...live],
        itemsShape: snap.itemsShape,
        history: snap.history,
        ...(snap.liveTurn ? { liveTurn: snap.liveTurn } : {}),
      };
    },
    /** A line the Host sent on the session of a machine that was not an answer. @param {string} machineId @param {any} line */
    onEvent(machineId, line) {
      // the Host names a Claude Code or Codex chat its own way; the phone follows it by the id the Mac lists
      const named = line?.chatId;
      if (typeof named !== 'string') return;
      const chatId = chats.has(named) ? named : appChatId(named);
      const c = chats.get(chatId);
      if (!c || c.machineId !== machineId) return;
      if (line.event === 'frame') c.pump(line.frame);
      else if (line.event === 'closed' && c.following) {
        c.following = false;
        stale(chatId, c);
      }
    },
    /**
     * The machine's session ended (the Host or the relay went, the app was away) or may have missed frames: every chat followed through it
     * is out of date, and the Thread reads it again (which subscribes again once the session is back).
     * @param {string} machineId
     */
    sessionEnded(machineId) {
      for (const [chatId, c] of chats) {
        if (c.machineId !== machineId || !c.following) continue;
        c.following = false;
        stale(chatId, c);
      }
    },
    /** @param {string} chatId */
    unfollow(chatId) {
      const c = chats.get(chatId);
      if (c) c.following = false;
      chats.delete(chatId);
      return { unfollowed: true };
    },
    /** @param {string} chatId */
    has: (chatId) => chats.has(chatId),
    /** The agent a followed chat's settled switches have moved it to, by the name the wire moves a chat with; none while it has not switched. @param {string} chatId */
    agentOf: (chatId) => chats.get(chatId)?.agent,
    /** The chats being followed now. */
    followed: () => [...chats].filter(([, c]) => c.following).map(([id]) => id),
    /**
     * `chat.send` to the Host itself. Pictures and files are not sent from here yet. @param {string} machineId @param {{ chatId: string, text: string, sendId?: string, attachments?: unknown[], skills?: unknown[] }} p
     */
    async send(machineId, p) {
      if (p.attachments?.length || p.skills?.length)
        throw Object.assign(new Error('Files are not sent to this machine from the phone yet.'), { code: 'unsupported' });
      const session = await host(machineId);
      const c = chatOf(p.chatId, machineId);
      const key = keyOf('send', p.sendId ?? `${p.chatId}\n${p.text}\n${now()}`);
      const sent = await withEpoch(c, (epoch) => session.send({ chatId: hostChatId(p.chatId), epoch, key, text: p.text, human: true }));
      // a start the Host refused is a refused send here too, with its reason
      assertTaken(sent);
      return sent;
    },
    /** @param {string} machineId @param {string} chatId @param {string} [turnId] */
    async stop(machineId, chatId, turnId) {
      const session = await host(machineId);
      const c = chatOf(chatId, machineId);
      const key = keyOf('stop', `${chatId}\n${turnId ?? ''}\n${c.rows.snapshot().liveTurn?.id ?? ''}`);
      return withEpoch(c, (epoch) => session.stop({ chatId: hostChatId(chatId), epoch, key, ...(turnId ? { turnId } : {}) }));
    },
    /**
     * Moves the chat to another agent with its next message, or (the chat's own agent) takes an earlier choice back. One `pickId` per tap: a retry is the same request.
     * @param {string} machineId @param {string} chatId @param {string} pickId @param {{ harness: string, model?: string, effort?: string }} pick
     */
    async switchTo(machineId, chatId, pickId, pick) {
      const session = await host(machineId);
      const c = chatOf(chatId, machineId);
      const key = keyOf('switch', `${chatId}\n${pickId}`);
      return resultOf(await withEpoch(c, (epoch) => session.switchTo({ chatId: hostChatId(chatId), epoch, key, ...pick })));
    },
    /** Sets the chat's permission mode. @param {string} machineId @param {string} chatId @param {string} pickId @param {string} value */
    async permit(machineId, chatId, pickId, value) {
      const session = await host(machineId);
      const c = chatOf(chatId, machineId);
      const key = keyOf('permit', `${chatId}\n${pickId}`);
      return resultOf(await withEpoch(c, (epoch) => session.permit({ chatId: hostChatId(chatId), epoch, key, value })));
    },
    /** A new chat on the machine; `startId` makes a retry the same chat. @param {string} machineId @param {{ chatId: string, startId: string, [k: string]: unknown }} p */
    async start(machineId, p) {
      const session = await host(machineId);
      const { startId, ...rest } = p;
      const started = await session.start({ epoch: 0, ...rest, chatId: hostChatId(rest.chatId), key: keyOf('start', startId) });
      assertTaken(started);
      return started;
    },
  };
}
