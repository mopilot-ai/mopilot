// Remote item feed: main-process translation of each harness family's raw live events into one thread-item stream for remote clients.
const { CoreBatcher } = require('./coreBatcher.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { TEXT_METHODS } = require('../../shared/streamDelta.mjs');
const { userInput } = require('../../shared/userInput.mjs');
const { phoneItemIdentity } = require('../../shared/phoneItemIdentity.mjs');

/** The items a chat's snapshot can hold at most, unless the caller asks for fewer. */
const RING = 50;
/** The batcher's tick for remote clients: 10 Hz. */
const TICK_MS = 100;
/** Bound remembered identities; unknown turns after exhaustion require a history refresh instead of unsafe reuse. */
const MAX_TRACKED_TURNS = 1000;
const FAMILY = 'feed';
/** Streamed fields a delta extends, by the notification that carries it. */
const DELTA_FIELD = new Map([
  ['item/agentMessage/delta', 'text'],
  ['item/reasoning/summaryTextDelta', 'summary'],
]);

/** @type {{ claude: any, acp: any } | null} */
let sharedModules = null;
/** The translators, loaded once on first use. */
function translatorModules() {
  const loaded = (sharedModules ??= { claude: require('./items/claudeTranslator.cjs'), acp: require('./items/acpTranslator.cjs') });
  return loaded;
}

/** A raw user event's message as the window path shows it (items/claude.cjs): its words, then its attachments. */
const userContent = (e) => userInput(String(e.text ?? ''), Array.isArray(e.attachments) ? e.attachments : []);
const UNSUPPORTED = Symbol('unsupported');
/** Raw kinds that carry nothing a thread shows (approval cards, titles, bookkeeping): accepted and dropped. */
const QUIET = new Set(['permission', 'permissionCancelled', 'elicitation', 'threadName', 'session', 'chatStarted', 'transcript', 'toast']);

/** Codex notifications are already item-shaped: a notification is forwarded as it is. */
const codexTranslator = {
  nativeKey: (raw) => raw?.params?.threadId,
  create: () => ({
    feed(raw, emit) {
      if (typeof raw?.method !== 'string') return UNSUPPORTED;
      emit(raw.method, raw.params ?? {});
    },
  }),
};

/** Claude Code: ClaudeTranslator, fed as main's windows are (electron/harness/items/claude.cjs). */
const claudeTranslator = {
  nativeKey: (raw) => raw?.key,
  create(chatId) {
    const { ClaudeTranslator } = translatorModules().claude;
    let current;
    const tr = new ClaudeTranslator(chatId, '', (method, params) => current(method, params), { children: false, sourceIds: true });
    return {
      feed(raw, emit) {
        current = emit;
        switch (raw?.kind) {
          case 'message':
            return void tr.onMessage(raw.msg);
          case 'turnStarting':
            return void tr.beginTurn(raw.turnId, { id: `u-${raw.clientId}`, clientId: raw.clientId, content: userContent(raw) });
          case 'steered': {
            // as the window path (items/claude.cjs): one live turn across steers, the message an in-order item of it
            const user = { id: raw.clientId, clientId: raw.clientId, content: userContent(raw) };
            if (!tr.turnId) return void tr.beginTurn(`ct-${raw.clientId}`, user);
            tr.addSteer();
            return void emit('item/completed', { threadId: chatId, turnId: tr.turnId, item: { type: 'userMessage', ...user } });
          }
          case 'steerFailed':
            return void tr.dropSteer();
          case 'interrupting':
            return void tr.markInterrupted();
          case 'turnFailed':
            return void tr.endTurn('failed', raw.error);
          case 'closed':
          case 'error':
            if (tr.turnId) tr.endTurn(tr.interrupted ? 'interrupted' : 'failed', raw.error ?? 'The session quit while working');
            return void (raw.kind === 'closed' && tr.close());
          default:
            return QUIET.has(raw?.kind) ? undefined : UNSUPPORTED;
        }
      },
      close: () => tr.close(),
    };
  },
};

/** Basic-tier chats over ACP: AcpTranslator, fed as main's windows are (electron/harness/items/acp.cjs). */
const acpTranslator = {
  nativeKey: (raw) => raw?.key,
  create(chatId) {
    const { AcpTranslator } = translatorModules().acp;
    let current;
    const tr = new AcpTranslator(chatId, '', (method, params) => current(method, params));
    return {
      feed(raw, emit) {
        current = emit;
        switch (raw?.kind) {
          case 'turnStart':
            return void tr.beginTurn(raw.turnId, raw.user);
          case 'update':
            return void tr.onUpdate(raw.update, raw.turnId);
          case 'turnEnd':
            return void tr.endTurn(raw.stopReason, raw.error ?? null, raw.providerError ?? null);
          case 'closed':
            if (tr.turnId) tr.endTurn('cancelled', null);
            return void tr.close();
          default:
            return QUIET.has(raw?.kind) || raw?.kind === 'turnStarting' ? undefined : UNSUPPORTED;
        }
      },
      close: () => tr.close(),
    };
  },
};

const DEFAULT_TRANSLATORS = { codex: codexTranslator, claude: claudeTranslator, acp: acpTranslator };

/** Native session identity belongs to the harness adapter; clients treat the resulting scope as opaque. */
function originOf(/** @type {'codex' | 'claude' | 'acp'} */ family, raw) {
  const key = DEFAULT_TRANSLATORS[family].nativeKey(raw);
  return JSON.stringify([family, typeof key === 'string' ? key : null]);
}

/** The chat of a feed event; the core's `feed` contract joins its `items.delta` (core/crates/batcher). */
const chatOfFeed = (e) => e.chatId;

/** The batcher's timers with every wait set to the remote tick. */
const tickTimers = (timers) => ({
  setTimeout: (fn) => timers.setTimeout(fn, TICK_MS),
  clearTimeout: timers.clearTimeout,
});

/**
 * One chat's items for remote clients, whatever its harness family.
 * Outgoing events: `{ ev: 'items.append', chatId, items }`, `{ ev: 'items.replace', chatId, items }`,
 * `{ ev: 'items.delta', chatId, itemId, field, text }` (coalesced, one per item and field per tick) and
 * `{ ev: 'turn.state', chatId, turnId, status }`.
 * @param {object} o
 * @param {(event: object) => void} o.emit
 * @param {Partial<Record<'codex' | 'claude' | 'acp', { create: (chatId: string) => { feed: (raw: any, emit: (method: string, params: any) => void) => unknown, close?: () => void } }>>} [o.translators]
 * @param {{ timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }, ring?: number }} [o.batcher]
 */
function createItemFeed({ emit, translators = {}, batcher: opts = {} }) {
  const table = { ...DEFAULT_TRANSLATORS, ...translators };
  const ringSize = opts.ring ?? RING;
  /** @type {Map<string, { items: any[], liveItems: any[], liveTurn: { id: string | null, status: string | null } | null, liveRetired: boolean, turns: Set<string>, historyChangedAt: number, translators: Map<string, any>, feedSeq: number }>} */
  const chats = new Map();
  let sequence = 0;
  const chatOf = (chatId) => {
    let c = chats.get(chatId);
    if (!c)
      chats.set(
        chatId,
        (c = {
          items: [],
          liveItems: [],
          liveTurn: null,
          liveRetired: false,
          turns: new Set(),
          historyChangedAt: 0,
          translators: new Map(),
          feedSeq: 0,
        }),
      );
    return c;
  };

  const send = (_family, event) => {
    const c = chatOf(event.chatId);
    let live = !c.liveRetired && (!c.liveTurn || c.liveTurn.id === event.turnId);
    if (event.ev === 'turn.state') {
      const validId = typeof event.turnId === 'string' && event.turnId.length > 0;
      const fresh = validId && !c.turns.has(event.turnId) && c.turns.size < MAX_TRACKED_TURNS;
      const duplicate =
        validId && !c.liveRetired && c.liveTurn !== null && c.liveTurn.id === event.turnId && c.liveTurn.status === 'inProgress';
      live = validId && (event.started ? fresh || duplicate : live && (c.turns.has(event.turnId) || fresh));
      if (live) {
        if (event.started && fresh) c.liveItems = [];
        c.liveRetired = false;
        c.turns.add(event.turnId);
        c.liveTurn = { id: event.turnId, status: event.status };
      } else if (event.started && validId && (c.liveTurn?.id === event.turnId || !c.turns.has(event.turnId))) c.liveRetired = true;
    } else if (event.ev === 'items.delta') {
      extend(c.items, event);
      if (live) extend(c.liveItems, event);
    } else {
      store(c.items, event.items, event.turnId);
      if (live) store(c.liveItems, event.items, event.turnId);
    }
    c.feedSeq = ++sequence;
    if (!live) c.historyChangedAt = c.feedSeq;
    try {
      emit({ ...event, live, feedSeq: c.feedSeq });
    } catch (error) {
      noteIgnored('hand a remote item event to its listener', error);
    }
    return true;
  };
  const batcher = new CoreBatcher({ send, watched: () => true, timers: /** @type {any} */ (tickTimers(opts.timers ?? globalThis)) });
  batcher.register(FAMILY, chatOfFeed);
  const out = (event) => batcher.push(FAMILY, event);

  /** The ring after an append or a replace: new ids at the end, known ids in place, the oldest dropped past the bound. */
  function store(ring, items, turnId) {
    for (const item of items) {
      const at = ring.findIndex((x) => x.item.id === item.id && x.turnId === turnId);
      const entry = { item, turnId };
      if (at >= 0) ring[at] = entry;
      else ring.push(entry);
    }
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
  }
  /** A delivered delta lengthens its item in the ring, so a snapshot matches what followers were sent. */
  function extend(ring, e) {
    const at = ring.findIndex((x) => x.item.id === e.itemId && x.turnId === e.turnId);
    if (at < 0) return;
    const item = ring[at].item;
    ring[at] = {
      ...ring[at],
      item:
        e.field === 'text'
          ? { ...item, text: `${item.text ?? ''}${e.text}` }
          : {
              ...item,
              summary: Object.assign([...(item.summary ?? [])], { [e.index]: `${item.summary?.[e.index] ?? ''}${e.text}` }),
            },
    };
  }

  function onNotification(chatId, method, params, origin, sourceSession) {
    const c = chatOf(chatId);
    const scoped = (id) => (origin !== undefined && typeof id === 'string' ? JSON.stringify([origin, id]) : (id ?? null));
    const turnId = scoped(params?.turnId);
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = params?.turn ?? {};
      return out({ ev: 'turn.state', chatId, turnId: scoped(turn.id), status: turn.status ?? null, started: method === 'turn/started' });
    }
    if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
      const stamped = params?.item;
      if (!stamped || stamped.id == null) return;
      const rowId = phoneItemIdentity(sourceSession, params?.turnId, stamped);
      const item = rowId ? { ...stamped, rowId } : stamped;
      batcher.flushChat(chatId);
      const known = c.items.find((x) => x.item.id === item.id && x.turnId === turnId);
      if (!known) return out({ ev: 'items.append', chatId, turnId, items: [item] });
      if (JSON.stringify(known.item) === JSON.stringify(item)) return;
      return out({ ev: 'items.replace', chatId, turnId, items: [item] });
    }
    const field = DELTA_FIELD.get(method);
    if (field && TEXT_METHODS.has(method) && typeof params?.delta === 'string' && params.itemId != null)
      out({
        ev: 'items.delta',
        chatId,
        turnId,
        itemId: params.itemId,
        field,
        index: field === 'summary' ? (params.summaryIndex ?? 0) : 0,
        text: params.delta,
      });
  }

  /** The cursor and copied items describe the same synchronous point after queued text has been applied. */
  function snapshot(chatId, n = ringSize) {
    batcher.flushChat(chatId);
    const c = chats.get(chatId);
    return {
      feedSeq: c?.feedSeq ?? 0,
      items: structuredClone(n > 0 ? (c?.items ?? []).slice(-n).map((entry) => entry.item) : []),
      // the same items with the turn each came in (an unpersisted chat's turns are rebuilt from them)
      entries: structuredClone(n > 0 ? (c?.items ?? []).slice(-n) : []),
      liveItems: structuredClone(n > 0 && !c?.liveRetired ? (c?.liveItems ?? []).slice(-n).map((entry) => entry.item) : []),
      liveTurn: structuredClone(c?.liveRetired ? null : (c?.liveTurn ?? null)),
      liveUnavailable: c?.liveRetired ?? false,
      historyChangedAt: c?.historyChangedAt ?? 0,
    };
  }

  return {
    /** @param {string} chatId @param {string} family @param {any} raw @param {string} [origin]
     * @returns {{ supported: boolean }} false when the family has no translator or the event kind is not translated in main */
    push(chatId, family, raw, origin = undefined) {
      const factory = table[family];
      if (!factory) return { supported: false };
      const c = chatOf(chatId);
      try {
        const source = JSON.stringify([family, origin]);
        let tr = c.translators.get(source);
        if (!tr) c.translators.set(source, (tr = factory.create(chatId)));
        if (
          tr.feed(raw, (method, params) => onNotification(chatId, method, params, origin, DEFAULT_TRANSLATORS[family]?.nativeKey(raw))) ===
          UNSUPPORTED
        )
          return { supported: false };
      } catch (error) {
        noteIgnored(`translate a ${family} event for a remote chat`, error);
      }
      return { supported: true };
    },
    /**
     * An item the app writes into the chat outside any harness turn (a browser hand-off's line): appended once, then replaced in
     * place by its id (turnId null): live while no turn runs, else a history change that sends followers back to the chat's rows.
     * @param {string} chatId @param {{ id: string }} item
     */
    appItem(chatId, item) {
      batcher.flushChat(chatId);
      const known = chatOf(chatId).items.some((x) => x.item.id === item.id && x.turnId === null);
      out({ ev: known ? 'items.replace' : 'items.append', chatId, turnId: null, items: [item] });
    },
    /** The chat's last `n` items and the live-event watermark already included in them. */
    snapshot,
    /** The chat's last `n` copied items, with every delivered delta applied. */
    snapshotItems(chatId, n = ringSize) {
      return snapshot(chatId, n).items;
    },
    /** No one follows any more, so no session's end will reach these: every translator goes, and an event would start one afresh. */
    closeTranslators() {
      for (const chat of chats.values()) {
        for (const tr of chat.translators.values()) tr.close?.();
        chat.translators.clear();
      }
    },
    /** The chat is gone: its translators, ring and pending text are dropped. */
    forget(chatId) {
      batcher.drop(chatId);
      for (const tr of chats.get(chatId)?.translators.values() ?? []) tr.close?.();
      chats.delete(chatId);
    },
  };
}

module.exports = { createItemFeed, originOf, RING, TICK_MS, MAX_TRACKED_TURNS };
