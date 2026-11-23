// The keyed stream batcher in main, kept by the Rust core (core/crates/batcher): each chat's queue, the keys, joins, sizes
// and waits are the core's; here are the timers, the sends and the events' own objects. The first delta after a quiet spell
// goes out at once (the leading edge), so a reply's first characters wait for no tick.
const { core, requiredCore } = require('../platform/core.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { remember } = require('./eventJson.cjs');
const { namedChats, orderedReplies } = require('./batcherRequests.cjs');

/** A tick while an app window is on screen, focused or not (someone may watch it while typing elsewhere): one frame. */
const WATCHED_MS = 16;
/** A tick while no app window is on screen, and the tick for windows that do not show a chat: Claude Desktop's off-screen cadence. */
const BACKGROUND_MS = 250;

/** A reply's flags (core/crates/batcher/src/routes.rs). */
const QUEUED = 1;
const MALFORMED = 2;
const SCHEDULE = 4;
const SCHEDULE_BACKGROUND = 8;

/**
 * Each family's gates, as the core gives them (`batcher.families`): an event no delta gate admits is no delta, so it is
 * never serialized, and one a wait gate admits waits unjoined without crossing at all.
 * @typedef {{ delta: (event: any) => boolean, waits: (event: any) => boolean }} Gates
 * @type {WeakMap<object, Record<string, Gates>>}
 */
const gatesOf = new WeakMap();

/** A gate's tests as one predicate: each field, read as `e?.a?.b` reads it, is one of the strings, or an object no array. */
function predicate(/** @type {[string[], string[] | null][] | null} */ tests) {
  if (!tests) return () => false;
  const compiled = tests.map(([path, values]) => /** @type {const} */ ([path, values && new Set(values)]));
  return (/** @type {any} */ event) =>
    compiled.every(([path, values]) => {
      let v = event;
      for (const key of path) v = v !== null && typeof v === 'object' ? v[key] : undefined;
      return values ? typeof v === 'string' && values.has(v) : v !== null && typeof v === 'object' && !Array.isArray(v);
    });
}

/** @param {any} addon */
function gates(addon) {
  let found = gatesOf.get(addon);
  if (!found) {
    const read = JSON.parse(String(addon.dispatchSync('batcher.families', Buffer.alloc(0))));
    found = Object.fromEntries(
      Object.entries(read).map(([family, g]) => [family, { delta: predicate(g.delta), waits: predicate(g.waits) }]),
    );
    gatesOf.set(addon, found);
  }
  return found;
}

/**
 * Every family's events on their way to windows. A delta to every window waits for the tick; anything else (and a delta
 * for one window) flushes its chat first and is sent now. Flushes are synchronous, so a request's answer or a broadcast
 * that flushes first never overtakes the deltas sent before it.
 */
class CoreBatcher {
  /**
   * @param {object} o
   * @param {(family: string, event: any, target: any, scope?: { chat: string, background: boolean }, envelope?: { hostId: string }) => boolean} o.send
   *   the family's existing channel to windows; a flushed delta carries the windows it is for (those not showing its chat, or the rest)
   * @param {(chat: string) => boolean} [o.hasBackground] whether a window is open that does not show the chat
   * @param {() => boolean} [o.watched] whether an app window is on screen (the tick is shorter)
   * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [o.timers] globalThis by default
   * @param {number} [o.maxPending] the per-chat bound on pending text, in UTF-16 units (the core's 256 Ki by default)
   * @param {(key: string) => string} [o.resolve] the chat a name from a window's request or a broadcast (a session key, a thread id) belongs to
   * @param {(fn: () => void) => void} [o.batch] runs `fn`, whose sends the caller may join into one message per window (the sends stay in order)
   * @param {((chat: string | null) => string) | null} [o.hostOf] the Host that owns a chat (null: an event outside any chat); when set, every
   *   send() gets `{ hostId }` as its fifth argument. Without it there is no envelope (the remote item feed)
   * @param {import('../platform/core.cjs').CoreAddon | null} [o.addon] the core; there is no batcher without one
   */
  constructor({
    send,
    watched = () => true,
    hasBackground = () => false,
    timers = globalThis,
    maxPending = undefined,
    hostOf = null,
    resolve = (key) => key,
    batch = (fn) => fn(),
    addon = core(),
  }) {
    // no core is the error every core call throws: there is no batcher without one
    this.addon = requiredCore(addon);
    this.dispatch = this.addon.dispatchSync;
    this.gates = gates(this.addon);
    this.send = send;
    this.resolve = resolve;
    this.batch = batch;
    this.hostOf = hostOf;
    this.hasBackground = hasBackground;
    this.watched = watched;
    /** read at each tick, so mocked timers apply */
    this.timers = timers;
    this.maxPending = maxPending;
    /** @type {Map<string, (event: any) => string | null>} each registered family's chatOf */
    this.chats = new Map();
    /** the events the core's queues hold by number: each with its family, envelope and how many entries it leads */
    /** @type {Map<number, { family: string, event: any, envelope?: { hostId: string }, refs: number }>} */
    this.held = new Map();
    this.seq = 0;
    /** how many chats have something pending in the core: none, and a flush need not ask */
    this.pending = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.backgroundTimer = null;
    /** the core's batcher, and what every payload to it starts with */
    this.id = '';
    this.prefix = '';
    this.open();
    // JS and the core ship together; a core from before Stage 4.4 ends no reply's list with a line, so every call would
    // fail and start the batcher over: say so once, where the app starts
    if (this.dispatch('batcher.cancel', Buffer.from(this.prefix)).indexOf(10) < 0)
      throw new Error(
        "The Rust core is older than this app's JS: its stream batcher's replies have no line before their events. Rebuild or reinstall the core.",
      );
  }

  /**
   * Its queues in the core: main's two batchers (the windows' and the remote item feed's) live as long as main, and the
   * core lets a JS environment's handles go with it.
   */
  open() {
    const bound = this.maxPending === undefined ? '' : String(this.maxPending);
    this.id = String(this.dispatch('batcher.open', Buffer.from(bound)));
    this.prefix = `${this.id}\n`;
  }

  /**
   * A family whose events pass the batcher, with the chat each belongs to (null: outside any chat). Its joins and keys
   * are the core's contract for it.
   * @param {string} family @param {(event: any) => string | null} chatOf
   */
  register(family, chatOf) {
    if (this.chats.has(family)) throw new Error(`a stream contract for ${family} is already registered`);
    if (!this.gates[family]) throw new Error(`the core has no stream contract for ${family}`);
    this.chats.set(family, chatOf);
  }

  /** The families registered. */
  families() {
    return [...this.chats.keys()];
  }

  /**
   * An event from a family's adapter for windows. Returns what the send returned, or true when queued.
   * @param {string} family @param {any} event @param {any} [target]
   */
  push(family, event, target) {
    const chatOf = this.chats.get(family);
    if (!chatOf) return this.send(family, event, target, undefined, this.envelope(null));
    const gate = this.gates[family];
    /** @type {string | null} */
    let chat = null;
    /** @type {string | null} */
    let json = null;
    let waits = false;
    // the chat as the core keys it; an id String() throws on is read as no chat could be
    let id = '';
    try {
      chat = chatOf(event);
      if (chat != null) id = String(chat);
      if (target === undefined && chat != null) {
        if (gate.delta(event)) {
          json = JSON.stringify(event);
          // a toJSON that gives nothing leaves no delta to read
          if (typeof json !== 'string') throw new Error('it has no JSON');
          // the text a window's stream batch carries, if nothing joins the delta first
          remember(event, json);
        } else waits = gate.waits(event);
      }
    } catch (error) {
      // a malformed event is keyless; with no chat known every chat's deltas go first, so none falls behind it
      noteIgnored(`read a ${family} stream event's chat and key`, error);
      this.flushAll();
      return this.send(family, event, target, undefined, this.envelope(null));
    }
    if (json === null && !waits) {
      if (chat != null) this.flush([id]);
      return this.send(family, event, target, undefined, this.envelope(chat));
    }
    // a restart that could not open the core's queues again: the event goes unbatched, and the next one tries again
    if (!this.reopen()) return this.send(family, event, target, undefined, this.envelope(chat));
    const seq = ++this.seq;
    const reply = this.call('batcher.push', `${seq}\n${family}\n${this.backgroundOf(id) ? 1 : 0}\n${JSON.stringify(id)}\n${json ?? ''}`);
    if (!reply) return this.send(family, event, target, undefined, this.envelope(chat));
    const [flags, refs] = reply;
    if (flags & MALFORMED) noteIgnored(`read a ${family} stream event's chat and key`, new Error('the core could not read its key'));
    if (refs) this.held.set(seq, { family, event, envelope: this.envelope(id), refs });
    this.deliver(reply, false);
    this.schedule(flags);
    if (flags & QUEUED) return true;
    return this.send(family, event, target, undefined, this.envelope(flags & MALFORMED ? null : chat));
  }

  /**
   * Route `route` with `text` after the batcher's id: its reply's list parsed, with the joined events' JSON after the list
   * as `joined`, which `sendOut` reads in order. A core that fails it (a bug: no route waits or
   * can fail on what it is given) is noted, and the batcher starts over with nothing pending: what it held is lost.
   * @param {string} route @param {string} [text]
   * @returns {any[] | null}
   */
  call(route, text = '') {
    if (!this.id) return null;
    try {
      const bytes = this.dispatch(route, Buffer.from(this.prefix + text));
      const end = bytes.indexOf(10);
      return Object.assign(JSON.parse(bytes.toString('utf8', 0, end)), { joined: { bytes, at: end + 1 } });
    } catch (error) {
      noteIgnored(`batch stream events in the core (${route})`, error);
      this.restart();
      return null;
    }
  }

  restart() {
    try {
      this.dispatch('batcher.close', Buffer.from(this.id));
    } catch (error) {
      noteIgnored('close a stream batcher in the core', error);
    }
    this.cancelTimers();
    this.held.clear();
    this.pending = 0;
    this.id = '';
    this.prefix = '';
    this.reopen();
  }

  /**
   * Whether the core holds this batcher's queues, opening them again where a restart could not (the core refused another
   * batcher, or the environment is going): until it can, events go out unbatched.
   */
  reopen() {
    if (this.id) return true;
    try {
      this.open();
      return true;
    } catch (error) {
      noteIgnored('open a stream batcher in the core', error);
      return false;
    }
  }

  /**
   * Send what a reply's groups say, each group (a chat's flush) in one batch, or all of them in one (a tick's).
   * @param {any} reply @param {boolean} together
   */
  deliver(reply, together) {
    this.pending = reply[2];
    if (reply.length === 3) return;
    // every entry's event is taken before any is sent: a send can call back in, and a core that fails then starts the
    // batcher over, which would lose what this reply already handed out
    /** @type {ReturnType<typeof this.entries>[]} */
    const groups = [];
    this.groups(reply, (chat, out) => groups.push(this.entries(chat, out, reply.joined)));
    if (together) this.batch(() => groups.forEach((entries) => this.sendOut(entries)));
    else for (const entries of groups) this.batch(() => this.sendOut(entries));
  }

  /** @param {any[]} reply @param {(chat: string, out: any[]) => void} each */
  groups(reply, each) {
    for (let at = 3; at < reply.length; at += 2) each(reply[at], reply[at + 1]);
  }

  /**
   * The held event an entry names, let go once no entry leads with it; undefined for a number the core never had from
   * here (a bug), which sends nothing.
   * @param {number} seq
   */
  take(seq) {
    const held = this.held.get(seq);
    if (held && --held.refs === 0) this.held.delete(seq);
    return held;
  }

  /**
   * A chat's flushed entries, (number, lane, the byte length of its joined event or 0) each, with what JS held for each
   * and a joined event's JSON, read from the reply's bytes in order.
   * @param {string} chat @param {any[]} out @param {{ bytes: Buffer, at: number }} joined
   */
  entries(chat, out, joined) {
    const entries = [];
    for (let at = 0; at < out.length; at += 3) {
      const length = out[at + 2];
      const json = length ? joined.bytes.toString('utf8', joined.at, (joined.at += length)) : null;
      entries.push({ seq: out[at], held: this.take(out[at]), scope: { chat, background: out[at + 1] === 1 }, json });
    }
    return entries;
  }

  /**
   * Send entries in order. A joined event is parsed for the senders, and its JSON kept for the windows
   * (electron/harness/eventJson.cjs). @param {ReturnType<typeof this.entries>} entries
   */
  sendOut(entries) {
    for (const { seq, held, scope, json } of entries) {
      try {
        if (!held) throw new Error(`the core flushed event ${seq}, which it was never given`);
        this.send(held.family, json === null ? held.event : remember(JSON.parse(json), json), undefined, scope, held.envelope);
      } catch (error) {
        // one window's failure must not drop the chat's later deltas
        noteIgnored(`send a ${held?.family} stream delta to the windows`, error);
      }
    }
  }

  /**
   * What travels beside an event: the hostId of the Host that owns its chat (the envelope a Host stream carries; windows
   * ignore it for now). The event itself is untouched, so the adapter's object, the ledger's record and a window's payload
   * stay as they were. Undefined when the batcher has no Host table. A lookup that throws leaves the event on the local Host.
   * @param {string | null} chat
   * @returns {{ hostId: string } | undefined}
   */
  envelope(chat) {
    if (!this.hostOf) return undefined;
    try {
      return { hostId: this.hostOf(chat) };
    } catch (error) {
      noteIgnored('read the Host that owns a chat', error);
      return { hostId: 'local' };
    }
  }

  /**
   * Run `fn` (a window's request: a chat's history, a thread read) and flush the pending deltas before its answer goes
   * out, so no answer overtakes events sent before it. The guarantee lives here, not in IPC: a Host stream replies the same way.
   * @template T
   * @param {() => T | Promise<T>} fn
   * @param {unknown[]} [args] the request's arguments: only the chats they name are flushed (none named: none); omitted: every chat
   * @returns {Promise<T>}
   */
  async ordered(fn, args) {
    try {
      return await fn();
    } finally {
      // a caller that does not say what the request names gets the whole guarantee
      if (args) this.flushNamed(namedChats(args));
      else this.flushAll();
    }
  }

  /**
   * Flush the chats a request or broadcast names (a chat id, or a key `resolve` maps to one), not every chat: other chats'
   * deltas keep their own cadence, so unrelated traffic never turns the coalescing off. Names that are no chat flush nothing.
   * @param {unknown[]} names
   */
  flushNamed(names) {
    /** @type {string[]} */
    const chats = [];
    for (const name of names) {
      if (name == null) continue;
      chats.push(String(name));
      let chat = name;
      try {
        chat = this.resolve(/** @type {string} */ (name));
      } catch (error) {
        noteIgnored('resolve the chat a request names', error);
      }
      if (chat !== name && chat != null) chats.push(String(chat));
    }
    this.flush(chats);
  }

  /** @param {string[]} chats */
  flush(chats) {
    if (!this.pending || !chats.length) return;
    const reply = this.call('batcher.flush', JSON.stringify(chats));
    if (reply) this.deliver(reply, false);
  }

  /** @param {string} chat */
  backgroundOf(chat) {
    try {
      return this.hasBackground(chat);
    } catch (error) {
      noteIgnored('read whether a window does not show a chat', error);
      return false;
    }
  }

  /** Send a chat's pending deltas now, in order: before its next event, its deletion or a harness switch. The tick keeps running. */
  flushChat(chat) {
    if (chat != null) this.flush([String(chat)]);
  }

  /** Send every chat's pending deltas now: a window closing, a view changing, an adapter stopping, before-quit, a broadcast. The tick keeps its cadence. */
  flushAll() {
    if (!this.pending) return;
    const reply = this.call('batcher.flushAll');
    if (reply) this.deliver(reply, false);
  }

  /** A chat that is gone: what it has pending is dropped, unsent. */
  drop(chat) {
    if (!this.pending) return;
    const reply = this.call('batcher.drop', JSON.stringify([String(chat)]));
    if (!reply) return;
    this.pending = reply[2];
    this.groups(reply, (_chat, out) => {
      for (let at = 0; at < out.length; at += 3) this.take(out[at]);
    });
  }

  /** The ticks the core asked for. */
  schedule(flags) {
    if (flags & SCHEDULE && !this.timer) this.timer = this.timers.setTimeout(() => this.tick(), this.interval());
    if (flags & SCHEDULE_BACKGROUND && !this.backgroundTimer)
      this.backgroundTimer = this.timers.setTimeout(() => this.backgroundTick(), BACKGROUND_MS);
  }

  /** A tick's end: what is pending for the windows that show each chat goes out, all chats at once; one that sent some starts the next. */
  tick() {
    this.timer = null;
    const reply = this.call('batcher.tick');
    if (!reply) return;
    this.deliver(reply, true);
    this.schedule(reply[0]);
  }

  /** The slower tick of the windows that do not show a chat: whatever is pending for them goes out, all chats at once. */
  backgroundTick() {
    this.backgroundTimer = null;
    const reply = this.call('batcher.backgroundTick');
    if (reply) this.deliver(reply, true);
  }

  /** The tick for what is on screen now. */
  interval() {
    try {
      return this.watched() ? WATCHED_MS : BACKGROUND_MS;
    } catch (error) {
      noteIgnored('read whether an app window is on screen', error);
      return BACKGROUND_MS;
    }
  }

  cancelTimers() {
    if (this.backgroundTimer) this.timers.clearTimeout(this.backgroundTimer);
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.backgroundTimer = null;
    this.timer = null;
  }

  /** No tick runs any more; what is pending waits for a flush. */
  cancel() {
    this.cancelTimers();
    this.call('batcher.cancel');
  }
}

/**
 * The chat each harness family's events belong to (one per family in electron/harness/family.cjs; tests/streamContracts.test.ts
 * holds the list to it). Codex's is the one main already mapped it to; a Claude or ACP session's is the controller's.
 * @param {{ chatOf: (key: string) => string }} o how a native session key maps to its chat
 * @returns {Record<'codex' | 'claude' | 'acp', (event: any) => string | null>}
 */
function familyChats({ chatOf }) {
  const bySession = (/** @type {any} */ e) => (typeof e?.key === 'string' ? chatOf(e.key) : (e?.chatId ?? null));
  return { codex: (e) => e?.chatId ?? e?.params?.threadId ?? null, claude: bySession, acp: bySession };
}

module.exports = { CoreBatcher, orderedReplies, namedChats, familyChats, WATCHED_MS, BACKGROUND_MS };
