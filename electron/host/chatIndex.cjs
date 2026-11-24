// The chats of every machine this Mac can see, as each machine's Host lists them (feature chatList: a Host without it answers `feature_missing` and is left alone, docs/host.md "Chat index, paging and events"): per machine one connection that watches first and buffers, pages the list to its end, then applies the events after the first page's baseline. The index shows exactly what `host.chats` and its events return (the Host decides what a client may see: veiled and MoMo chats never arrive), holds a bounded number of rows per machine, never dials a machine that is offline or turned off, and tells a notifier about a turn that ended or a card that waits only when the event came after the baseline.
const { clock } = require('../platform/ports/clock.cjs');
const { sayHello } = require('./helloFirst.cjs');

/** Rows held per machine: the newest by activity. A machine with 20,000 chats keeps 2,000 here (about 1.2 MB: ten short fields a row, the title cut at 160 characters and the folder at 400). */
const MAX_ROWS = 2000;
const PAGE = 200;
const TITLE_MAX = 160;
const FOLDER_MAX = 400;
const ID_MAX = 200;
/** Waits before a machine's index is tried again after a failure or a partial list; the last one repeats. */
const RETRY_MS = [2000, 10_000, 30_000, 60_000];
/** A list that held this long counts as stable: the next failure starts the waits again (a Host that asks for a new list every few seconds keeps growing them). */
const STABLE_MS = 60_000;
/** How long one request to a Host may take before the machine counts as not answering. */
const CALL_MS = 30_000;
/** Changes reach the windows at most this often: a busy machine's events collapse into one snapshot. */
const COALESCE_MS = 100;
/** Events held while the pages are read; more than this and the list is read again. */
const BUFFER_MAX = 2000;
/** At most this many notifications from one machine in NOTICE_WINDOW_MS: a Host that sends a flood of events is a flood of nothing, not of banners. */
const NOTICES_PER_WINDOW = 3;
const NOTICE_WINDOW_MS = 60_000;
/** Chats events that tell a person something. */
const NOTIFY = new Set(['turnEnded', 'attention']);
/** A chat id is what the Host names a chat by: letters, digits and `_ : . -`, never an object key that means something. */
const ID = /^[A-Za-z0-9_:.-]+$/;
const UNSAFE_ID = new Set(['__proto__', 'constructor', 'prototype']);

/** At most `max` characters, never ending in half of a surrogate pair. @param {unknown} v @param {number} max */
const text = (v, max) => {
  if (typeof v !== 'string') return '';
  const cut = v.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return v.length > max && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};
/** A count or a time: a whole, non-negative number, else 0. @param {unknown} v */
const whole = (v) => (Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0);

/**
 * A row as the window draws it, whatever else the Host sent; null for something that is not a row.
 * @param {any} r
 */
function rowOf(r) {
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.chatId !== 'string' ||
    r.chatId.length > ID_MAX ||
    !ID.test(r.chatId) ||
    UNSAFE_ID.has(r.chatId)
  )
    return null;
  const state = r.state === 'running' || r.state === 'attention' ? r.state : 'idle';
  return {
    chatId: r.chatId,
    title: text(r.title, TITLE_MAX),
    harness: text(r.harness, 40),
    createdAt: whole(r.createdAt),
    updatedAt: whole(r.updatedAt),
    epoch: whole(r.epoch),
    rev: whole(r.rev),
    state,
    ...(typeof r.folder === 'string' && r.folder ? { folder: text(r.folder, FOLDER_MAX) } : {}),
    ...(typeof r.startedBy === 'string' && r.startedBy ? { startedBy: text(r.startedBy, 80) } : {}),
  };
}

/** @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {object} o
 * @param {(record: any, onEvent: (event: Record<string, any>) => void) => Promise<{ call: (method: string, params?: object) => Promise<any>, close: () => void }>} o.open one authenticated connection to a machine's Host; the `connection.closed` event tells that it ended
 * @param {() => { id: string, online: boolean, off?: boolean, pin?: string, record: any }[]} o.machines what the registry knows now (`pin`: what the machine's Host is known by, which changes when the machine is paired again)
 * @param {(machineId: string, kind: 'turnEnded' | 'attention', row: NonNullable<ReturnType<typeof rowOf>>) => void} [o.notify]
 * @param {() => void} [o.onChange]
 * @param {(error: unknown) => void} [o.report]
 * @param {number} [o.maxRows]
 * @param {number} [o.pageSize]
 */
function createChatIndex({
  open,
  machines,
  notify = () => undefined,
  onChange = () => undefined,
  report = () => undefined,
  maxRows = MAX_ROWS,
  pageSize = PAGE,
}) {
  /** @typedef {{ state: 'loading' | 'ready' | 'partial' | 'failed' | 'stale' | 'unsupported', rows: Map<string, NonNullable<ReturnType<typeof rowOf>>>, truncated: boolean, run: number, session: { close: () => void } | null, tries: number, timer: any, generation: string, baseline: number, pin: string, okAt: number, notices: number[] }} Entry */
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  let disposed = false;
  let runs = 0;
  /** @type {any} */
  let flush = null;
  /** The most pages one list may take: a short page is allowed (the Host leaves out what this client may not see), a list that never ends is not. */
  const maxPages = Math.ceil(maxRows / pageSize) * 3 + 10;

  /** A change for the windows, sent once after a short wait however many came. */
  const changed = () => {
    if (disposed || flush) return;
    flush = clock.setTimeout(() => {
      flush = null;
      try {
        onChange();
      } catch (error) {
        report(error);
      }
    }, COALESCE_MS);
  };
  /** @param {string} id @param {'turnEnded' | 'attention'} kind @param {NonNullable<ReturnType<typeof rowOf>>} row */
  const tell = (id, kind, row) => {
    try {
      notify(id, kind, row);
    } catch (error) {
      report(error);
    }
  };

  /** @param {Entry} e */
  const stop = (e) => {
    e.run = 0;
    clock.clearTimeout(e.timer);
    e.timer = null;
    const s = e.session;
    e.session = null;
    try {
      s?.close();
    } catch (error) {
      report(error);
    }
  };

  /** Puts the row in; past the cap the single oldest row goes (it may be this one) and the machine says it holds only some. @param {Entry} e @param {NonNullable<ReturnType<typeof rowOf>>} row */
  function hold(e, row) {
    e.rows.set(row.chatId, row);
    if (e.rows.size <= maxRows) return;
    /** @type {typeof row | null} */
    let oldest = null;
    for (const r of e.rows.values())
      if (!oldest || r.updatedAt < oldest.updatedAt || (r.updatedAt === oldest.updatedAt && r.chatId > oldest.chatId)) oldest = r;
    e.rows.delete(/** @type {NonNullable<typeof oldest>} */ (oldest).chatId);
    e.truncated = true;
  }

  /** One row or removal from an event; a row not newer than the one held never replaces it. `row` is set when the event is news about a chat (held or not), `dirty` when what the window draws changed. @param {Entry} e @param {any} ev */
  function apply(e, ev) {
    if (ev.op === 'remove') return { dirty: typeof ev.chatId === 'string' && e.rows.delete(ev.chatId), row: null, held: false };
    const row = ev.op === 'upsert' ? rowOf(ev.chat) : null;
    if (!row) return { dirty: false, row: null, held: false };
    const held = e.rows.get(row.chatId);
    if (held && row.rev <= held.rev) return { dirty: false, row: null, held: true };
    hold(e, row);
    return { dirty: e.rows.has(row.chatId), row, held: Boolean(held) };
  }

  /** @param {string} id @param {Entry} e @param {'loading' | 'partial' | 'failed'} state */
  function retry(id, e, state) {
    stop(e);
    e.state = state;
    if (e.okAt && clock.now() - e.okAt >= STABLE_MS) e.tries = 0;
    e.tries += 1;
    e.timer = clock.setTimeout(() => void start(id), RETRY_MS[Math.min(e.tries - 1, RETRY_MS.length - 1)]);
    changed();
  }

  /** Whether the row's state is what the kind of event claims: a card that waits is `attention`, a turn that ended is not `running`. @param {string} kind @param {NonNullable<ReturnType<typeof rowOf>>} row */
  const saysSo = (kind, row) => (kind === 'attention' ? row.state === 'attention' : row.state !== 'running');
  /** Whether this machine may notify again now; counts the one it allows. @param {Entry} e */
  function allowNotice(e) {
    const now = clock.now();
    e.notices = e.notices.filter((t) => now - t < NOTICE_WINDOW_MS);
    if (e.notices.length >= NOTICES_PER_WINDOW) return false;
    e.notices.push(now);
    return true;
  }

  /** One event after the baseline; false when it says the list is out of date (it is read again). @param {string} id @param {Entry} e @param {any} ev */
  function handle(id, e, ev) {
    if (ev.op === 'resync' || ev.generation !== e.generation) {
      retry(id, e, 'loading');
      return false;
    }
    if (!Number.isSafeInteger(ev.seq) || ev.seq <= e.baseline) return true; // read in the list already (or not a count at all)
    const { dirty, row, held } = apply(e, ev);
    // news is a chat this Mac already lists whose row now says what the event says; a Host cannot make banners out of chats it invents, and a flood is cut
    if (row && held && NOTIFY.has(ev.kind) && saysSo(ev.kind, row) && allowNotice(e)) tell(id, ev.kind, row);
    if (dirty) changed();
    return true;
  }

  /** One request, with an end: a Host that never answers is a machine that does not answer. @param {{ call: (method: string, params?: object) => Promise<any> }} session @param {string} method @param {object} [params] */
  function ask(session, method, params) {
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(refusal('The machine did not answer.', 'host_unreachable')), CALL_MS);
      session.call(method, params).then(
        (v) => (clock.clearTimeout(timer), resolve(v)),
        (error) => (clock.clearTimeout(timer), reject(error)),
      );
    });
  }

  /** Watch, buffer, page to the end, then the events after the baseline; what the registry says now decides whether to dial at all. @param {string} id */
  async function start(id) {
    const e = /** @type {Entry} */ (entries.get(id)); // a wait ends with its machine's entry (stop), so the entry is there
    const m = machines().find((x) => x.id === id);
    stop(e);
    if (!m || !m.online || m.off === true) {
      if (e.state !== 'stale') (e.state = 'stale'), changed();
      return;
    }
    const run = (e.run = ++runs);
    const live = () => e.run === run && !disposed;
    e.pin = m.pin ?? '';
    e.generation = '';
    e.baseline = 0;
    /** @type {any[] | null} events while the pages are read, then null: live. */
    let buffer = [];
    const onEvent = (/** @type {Record<string, any>} */ ev) => {
      if (!live()) return;
      if (ev.event === 'connection.closed') return retry(id, e, 'failed');
      if (ev.event !== 'chats') return;
      if (!buffer) return void handle(id, e, ev);
      if (buffer.length >= BUFFER_MAX) return retry(id, e, 'loading');
      buffer.push(ev);
    };
    e.state = e.rows.size ? 'stale' : 'loading';
    changed();
    try {
      const session = await open(m.record, onEvent);
      if (!live()) return void session.close();
      e.session = session;
      // a Host answers the versioned methods only after hello (and a Host without the chat list or its events refuses with feature_missing)
      const agreed = await sayHello({ call: (method, params) => ask(session, method, params) }, 'host.chats.watch');
      if (!live()) return;
      if (!agreed.features.includes('chatList')) throw refusal('That Host cannot list its chats. Update it.', 'feature_missing');
      const paging = agreed.features.includes('chatPaging');
      const watched = await ask(session, 'host.chats.watch');
      if (!live()) return;
      const generation = text(watched?.generation, 80);
      if (!generation) throw refusal('The machine did not say which run of its Host this is.', 'bad_answer');
      e.generation = generation;
      /** @type {Map<string, NonNullable<ReturnType<typeof rowOf>>>} */
      const fresh = new Map();
      const seen = new Set();
      let cursor;
      let incomplete = false;
      let truncated = false;
      for (let pages = 0; ; pages++) {
        if (pages >= maxPages) throw refusal('The machine’s chat list does not end.', 'bad_answer');
        const page = await ask(session, 'host.chats', { limit: pageSize, ...(paging && cursor ? { cursor } : {}) });
        if (!live()) return;
        if (text(page?.generation, 80) !== generation) return retry(id, e, 'loading');
        if (pages === 0) e.baseline = whole(page?.at);
        incomplete ||= page?.incomplete === true;
        for (const r of Array.isArray(page?.chats) ? page.chats : []) {
          const row = rowOf(r);
          if (row) fresh.set(row.chatId, row);
        }
        // a Host that has not offered paging shows its newest page only, and is never sent a cursor
        cursor = paging && typeof page?.next === 'string' && page.next ? page.next : undefined;
        if (!paging && Array.isArray(page?.chats) && page.chats.length >= pageSize) truncated = true;
        if (cursor && seen.has(cursor)) throw refusal('The machine’s chat list repeats itself.', 'bad_answer');
        if (cursor) seen.add(cursor);
        if (!cursor || fresh.size >= maxRows) {
          truncated ||= Boolean(cursor);
          break;
        }
      }
      // what the Host lists now replaces what was held: a chat it no longer shows (its scope changed, or it was removed) goes
      // the last page may carry the list past the cap: only the newest rows stay
      if (fresh.size > maxRows) {
        const newest = [...fresh.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.chatId.localeCompare(b.chatId)).slice(0, maxRows);
        e.rows = new Map(newest.map((r) => [r.chatId, r]));
        truncated = true;
      } else e.rows = fresh;
      e.truncated = truncated;
      const queued = buffer;
      buffer = null;
      e.state = incomplete ? 'partial' : 'ready';
      e.okAt = clock.now();
      // the events that came while the pages were read and are after the baseline are news like any other
      for (const ev of queued) if (!handle(id, e, ev)) return;
      if (incomplete) return retry(id, e, 'partial');
      changed();
    } catch (error) {
      if (!live()) return;
      // a Host that does not offer the list (an older build) is not tried again until the machine has been away and is back
      if (/** @type {any} */ (error)?.code === 'feature_missing' || /** @type {any} */ (error)?.code === 'unknown_method') {
        stop(e);
        e.state = 'unsupported';
        return changed();
      }
      report(error);
      retry(id, e, 'failed');
    }
  }

  /** What the registry says now decides who is connected: an online machine that is not turned off; the rest is closed (timers too) and keeps its rows as stale; a machine that is gone loses them; a machine paired again is read again. */
  function sync() {
    if (disposed) return;
    const now = machines();
    const ids = new Set(now.map((m) => m.id));
    for (const [id, e] of entries) {
      if (ids.has(id)) continue;
      stop(e);
      entries.delete(id);
      changed();
    }
    for (const m of now) {
      let e = entries.get(m.id);
      if (!(m.online && m.off !== true)) {
        if (e) {
          stop(e);
          if (e.state !== 'stale') (e.state = 'stale'), changed();
        }
        continue;
      }
      if (!e) {
        e = {
          state: 'loading',
          rows: new Map(),
          truncated: false,
          run: 0,
          session: null,
          tries: 0,
          timer: null,
          generation: '',
          baseline: 0,
          pin: m.pin ?? '',
          okAt: 0,
          notices: [],
        };
        entries.set(m.id, e);
      } else if (e.state === 'unsupported') continue;
      else if (e.run || e.timer) {
        if ((m.pin ?? '') === e.pin) continue; // already followed
        // the machine was paired again: its old connection belongs to the old key
      }
      void start(m.id);
    }
  }

  return {
    sync,
    /** Every machine's index: its state and its rows, newest activity first. */
    snapshot: () =>
      [...entries].map(([machineId, e]) => ({
        machineId,
        state: e.state,
        truncated: e.truncated,
        rows: [...e.rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.chatId.localeCompare(b.chatId)),
      })),
    dispose() {
      disposed = true;
      clock.clearTimeout(flush);
      flush = null;
      for (const e of entries.values()) stop(e);
      entries.clear();
    },
  };
}

module.exports = {
  createChatIndex,
  rowOf,
  MAX_ROWS,
  NOTICES_PER_WINDOW,
  NOTICE_WINDOW_MS,
  CALL_MS,
  COALESCE_MS,
  BUFFER_MAX,
  RETRY_MS,
  STABLE_MS,
};
