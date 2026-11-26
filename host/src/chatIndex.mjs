// The Host's in-memory index of its chats' summaries (`host.chats` and its change events): built from the journals' summary files, then kept current by what the stream hub already sees (a durable item, a state patch, a removal, an owner's epoch moving), so a list never scans the sessions folder again and a client learns of a chat another client started without asking. The journals stay the authority: a restart builds it again (the first build reads every chat's summary file, and stats its journal for the time of its last write).
import crypto from 'node:crypto';
import { harnessOfHostChat } from '../../shared/host/chatIds.mjs';
import { sideChatUuid } from '../../shared/host/sideChats.mjs';

/** What a chat is doing, as a list row says it. */
export const CHAT_STATES = /** @type {const} */ (['idle', 'running', 'attention']);

/** The cursor of a row: its place in the order (newest activity first, then id), opaque to a client. @param {{ updatedAt: number, chatId: string }} r */
export const cursorOf = (r) => Buffer.from(JSON.stringify([r.updatedAt, r.chatId])).toString('base64url');

/** A cursor's place, or null for one this Host never made. @param {unknown} cursor @returns {[number, string] | null} */
export function placeOf(cursor) {
  try {
    const place = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Array.isArray(place) && place.length === 2 && Number.isSafeInteger(place[0]) && typeof place[1] === 'string'
      ? [place[0], place[1]]
      : null;
  } catch {
    return null;
  }
}

/** Whether row `a` comes before row `b`. @param {{ updatedAt: number, chatId: string }} a @param {{ updatedAt: number, chatId: string }} b */
export const before = (a, b) => a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.chatId < b.chatId);

/** The index of the first row of `sorted` (newest activity first) that comes after a place, by bisection (the order is total). @param {{ updatedAt: number, chatId: string }[]} sorted @param {[number, string] | null} place */
export function firstAfter(sorted, place) {
  const after = place ? { updatedAt: place[0], chatId: place[1] } : null;
  let lo = 0;
  let hi = sorted.length;
  while (after && lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(after, /** @type {{ updatedAt: number, chatId: string }} */ (sorted[mid]))) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The kind of attention a state patch (or a summary) says: the Host publishes `{ kind, since, … }` or null; a bare string is a kind. @param {unknown} v */
export const attentionKind = (v) =>
  typeof v === 'string' && v
    ? v
    : v && typeof v === 'object' && typeof (/** @type {any} */ (v).kind) === 'string'
      ? /** @type {any} */ (v).kind
      : null;

/**
 * @typedef {{ chatId: string, title: string, harness?: string, folder?: string, startedBy?: string, byFp?: string, attn?: string, standIn?: true, createdAt: number, updatedAt: number }} Summary what the journals' summaries say of a chat
 * @typedef {Summary & { running: boolean, attention: string | null, rev: number }} Row
 * @typedef {{ event: 'chats', chatId?: string, generation: string, seq: number, op: 'upsert' | 'remove' | 'resync', kind?: string, rev?: number, chat?: object }} ChatsEvent
 */

/**
 * @param {object} o
 * @param {() => Promise<Summary[]>} o.load the chats the journals hold (the chat log's list)
 * @param {(chatId: string) => number} o.epoch the epoch a chat's next write must carry
 * @param {() => number} [o.now]
 * @param {(message: string) => void} [o.report]
 * @param {string} [o.generation] names this Host process's numbering (a restart starts every count again, and says so by a new one)
 */
export function createChatIndex({ load, epoch, now = Date.now, report, generation = crypto.randomUUID() }) {
  /** @type {Map<string, Row>} */
  const rows = new Map();
  /** @type {Set<{ send: (e: ChatsEvent) => unknown, scope?: import('./chatScope.mjs').ChatScope, n: number, stale: boolean, native?: true }>} */
  const watchers = new Set();
  /** Who is told when a chat comes or goes (the native index drops a session this Host starts to run). @type {Set<(chatId: string) => void>} */
  const rowListeners = new Set();
  /** @param {string} chatId */
  const rowChanged = (chatId) => {
    for (const fn of [...rowListeners]) {
      try {
        fn(chatId);
      } catch (error) {
        report?.(`A chat-list listener failed: ${error}`);
      }
    }
  };
  /** @type {Promise<boolean> | null} */
  let building = null;
  /** Whether a build of the journals' list has finished (well or not): until then what the hub sees waits for it, so a chat saved before this Host started keeps its own title and date. */
  let attempted = false;
  /** Whether the list is whole: a build that failed leaves what the hub has told since the start, and the next list or watch tries again. */
  let complete = false;
  /** The rows in the order of a list (newest activity first), made again when a row came, went or moved. @type {Row[] | null} */
  let order = null;
  /** What a client is told of a row: the name of the device that started the chat only when its scope may read names, and never the key it is known by. @param {Row} row @param {import('./chatScope.mjs').ChatScope} [scope] */
  const wire = ({ running, attention, byFp, startedBy, attn: _attn, ...r }, scope) => ({
    ...r,
    ...(startedBy && (!scope || scope.names({ byFp })) ? { startedBy } : {}),
    harness: r.harness ?? harnessOfHostChat(r.chatId),
    state: attention ? 'attention' : running ? 'running' : 'idle',
    epoch: epoch(r.chatId),
  });
  /**
   * Tells each watcher whose scope sees the row, numbering what it is told per watcher (a count that moved with every Host-wide change would show a client that may not see a chat when, and how much, it happens). A watcher whose connection said it is behind is told once to list again, and hears nothing else until it took that.
   * @param {string} kind @param {Row} row the chat's row (a removed chat's last one)
   */
  const tell = (kind, row) => {
    for (const w of [...watchers]) {
      try {
        if (w.scope && !w.scope.sees(row.chatId, row)) continue;
        if (w.stale) {
          if (w.send({ event: 'chats', generation, seq: ++w.n, op: 'resync' }) !== false) w.stale = false;
          continue;
        }
        const sent = w.send({
          event: 'chats',
          chatId: row.chatId,
          generation,
          seq: ++w.n,
          op: kind === 'removed' ? 'remove' : 'upsert',
          kind,
          rev: row.rev,
          ...(kind === 'removed' ? {} : { chat: wire(row, w.scope) }),
        });
        if (sent === false) w.stale = true;
      } catch (error) {
        report?.(`A chat-list event could not be sent: ${error}`);
      }
    }
  };
  /**
   * Applies what the hub saw of a chat: a finished item (it has activity; a turn begins or ends), a state patch (its title, agent, folder, attention), its owner's epoch moving or its removal. Tells the watchers only of a change a row shows.
   * @param {string} chatId @param {Record<string, any>} body
   */
  const seen = (chatId, body) => {
    if (body.t === 'removed') {
      const gone = rows.get(chatId);
      if (gone && rows.delete(chatId)) {
        order = null;
        tell('removed', gone);
        rowChanged(chatId);
      }
      return;
    }
    const at = now();
    let row = rows.get(chatId);
    // an owner that moved says nothing of a chat this Host does not list
    if (!row && body.t === 'epoch') return;
    const created = !row;
    if (!row) {
      rows.set(chatId, (row = { chatId, title: '', createdAt: at, updatedAt: at, running: false, attention: null, rev: 0 }));
      order = null;
    }
    let changed = created || body.t === 'epoch';
    let kind = created ? 'created' : 'changed';
    /** @param {boolean} differs */
    const note = (differs) => {
      changed ||= differs;
    };
    if (body.t === 'durable') {
      if (row.updatedAt !== at) order = null;
      row.updatedAt = at;
      const e = body.item?.t === 'event' ? body.item.event : null;
      if (e?.kind === 'turnStart') {
        note(!row.running);
        row.running = true;
      } else if (e?.kind === 'turnEnd') {
        note(row.running);
        row.running = false;
        kind = 'turnEnded';
        changed = true;
      }
    } else if (body.t === 'state') {
      const p = body.patch ?? {};
      if (p.title && typeof p.title === 'object') {
        const title = String(p.title.name || p.title.provisional || '').slice(0, 200);
        note(title !== row.title);
        row.title = title;
      }
      if (typeof p.harness === 'string') {
        note(p.harness !== row.harness);
        row.harness = p.harness;
      }
      if (p.origin && typeof p.origin === 'object') {
        if (typeof p.origin.folder === 'string') note(p.origin.folder !== row.folder), (row.folder = p.origin.folder);
        if (typeof p.origin.by === 'string') note(p.origin.by !== row.startedBy), (row.startedBy = p.origin.by);
        if (typeof p.origin.fp === 'string') row.byFp = p.origin.fp;
      }
      if ('attention' in p) {
        const attention = attentionKind(p.attention);
        if (attention && attention !== row.attention) kind = 'attention';
        note(attention !== row.attention);
        row.attention = attention;
      }
      if (changed && row.updatedAt !== at) {
        row.updatedAt = at;
        order = null;
      }
    }
    if (changed) {
      row.rev++;
      tell(kind, row);
    }
    if (created) rowChanged(chatId);
  };
  const index = {
    generation,
    /** Whether the list is whole (a build that failed leaves it partial until a later one succeeds). */
    get complete() {
      return complete;
    },
    /** Reads the journals' summaries into the index; a chat already told of keeps what it was told. A build that failed is tried again by the next call. @returns {Promise<boolean>} whether the list is whole */
    ready() {
      building ??= (async () => {
        try {
          for (const s of await load())
            if (!rows.has(s.chatId) && !sideChatUuid(s.chatId)) {
              const { attn, ...summary } = s;
              rows.set(s.chatId, { ...summary, running: false, attention: attn ?? null, rev: 1 });
            }
          order = null;
          complete = true;
        } catch (error) {
          // a Host that cannot read its journals lists what it has been told of since it started, and tries again at the next list
          report?.(`The chat index could not be built: ${error}`);
          building = null;
        }
        attempted = true;
        return complete;
      })();
      return building;
    },
    /**
     * What the hub saw of a chat (see `seen`). Before a build has finished it waits for it. Never throws: a row that cannot follow must not fail the write that made it.
     * @param {string} chatId @param {Record<string, any>} body
     */
    observe(chatId, body) {
      if (sideChatUuid(chatId)) return;
      if (!attempted) return void index.ready().then(() => index.observe(chatId, body));
      try {
        seen(chatId, body);
      } catch (error) {
        report?.(`The chat index could not follow chat ${chatId}: ${error}`);
      }
    },
    /**
     * One page of the list, newest activity first, from the place a cursor names (or the start). What the caller may not see is left out before the page is cut, and no total is told, so a page tells nothing about the chats left out. The order is kept between calls and only the rows from the cursor on are looked at, until the page is full.
     * @param {{ limit: number, cursor?: string }} p @param {import('./chatScope.mjs').ChatScope} [scope] what the caller may see @param {() => number} [at] the numbering of the caller's own watch, read as the rows are (0 without one)
     * @returns {Promise<{ chats: ReturnType<typeof wire>[], next?: string, at: number, generation: string, incomplete?: true }>}
     */
    async page({ limit, cursor }, scope, at = () => 0) {
      await index.ready();
      const place = cursor === undefined ? null : placeOf(cursor);
      if (cursor !== undefined && !place) throw Object.assign(new Error('That is not a place in this list.'), { code: 'bad_cursor' });
      const sorted = (order ??= [...rows.values()].sort((a, b) => (before(a, b) ? -1 : 1)));
      const lo = firstAfter(sorted, place);
      /** @type {Row[]} */
      const got = [];
      for (let i = lo; i < sorted.length && got.length <= limit; i++) {
        const r = /** @type {Row} */ (sorted[i]);
        if (!scope || scope.sees(r.chatId, r)) got.push(r);
      }
      const chats = got.slice(0, limit).map((r) => wire(r, scope));
      const last = got[limit - 1];
      return {
        chats,
        ...(got.length > limit && last ? { next: cursorOf(last) } : {}),
        at: at(),
        generation,
        ...(complete ? {} : { incomplete: true }),
      };
    },
    /**
     * Tells the watchers that asked for them (and may see them) of a native session's row, on each one's own numbering; a watcher that is behind is told once to list again, as for a chat.
     * @param {'created' | 'changed' | 'removed'} kind @param {string} chatId @param {number} rev @param {object} [chat] the whole row (none for a removal)
     */
    announce(kind, chatId, rev, chat) {
      for (const w of [...watchers]) {
        if (!w.native) continue;
        try {
          if (w.stale) {
            if (w.send({ event: 'chats', generation, seq: ++w.n, op: 'resync' }) !== false) w.stale = false;
            continue;
          }
          const sent = w.send({
            event: 'chats',
            chatId,
            generation,
            seq: ++w.n,
            op: kind === 'removed' ? 'remove' : 'upsert',
            kind,
            rev,
            ...(kind === 'removed' ? {} : { chat }),
          });
          if (sent === false) w.stale = true;
        } catch (error) {
          report?.(`A chat-list event could not be sent: ${error}`);
        }
      }
    },
    /** Calls `fn` with the id of each chat that comes or goes; returns what stops it. @param {(chatId: string) => void} fn */
    onRow(fn) {
      rowListeners.add(fn);
      return () => void rowListeners.delete(fn);
    },
    /** Whether the Host holds a chat of this id (in the order of its list, whoever may see it). @param {string} chatId */
    has: (chatId) => rows.has(chatId),
    /** A summary the list found from a journal for a chat that had a stand-in: kept without a change event, since nothing about the chat changed. @param {string} chatId @param {{ title: string, harness?: string }} found */
    filled(chatId, found) {
      const row = rows.get(chatId);
      if (!row) return;
      row.title = found.title;
      if (found.harness) row.harness = found.harness;
      delete row.standIn;
    },
    /** @param {string} chatId */
    standIn: (chatId) => !!rows.get(chatId)?.standIn,
    /**
     * Starts telling a connection of changes. The events carry a count of this watch's own (`seq`; a list read after the watch says `at`, and events after it are news) and the Host's generation.
     * @param {(e: ChatsEvent) => unknown} send what the connection takes an event with; a `false` answer says it is behind, and it is told once to list again @param {import('./chatScope.mjs').ChatScope} [scope] @param {{ native?: boolean }} [asked] `native` also tells it of native sessions' rows (#5576), if its scope may see them, on the same numbering
     */
    watch(send, scope, asked = {}) {
      const w = { send, scope, n: 0, stale: false, ...(asked.native && scope?.native ? { native: /** @type {const} */ (true) } : {}) };
      watchers.add(w);
      return { at: 0, generation, seq: () => w.n, stop: () => void watchers.delete(w) };
    },
  };
  return index;
}
