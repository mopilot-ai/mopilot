// The Host's in-memory index of native sessions (#5576, Phase 4): the sessions Claude Code and Codex hold on this machine that a person started outside MoPilot, as the read-only rows `host.chats {origin}` lists. Kept apart from the chat index so the journals stay the authority for Host chats; a discoverer (host/src/native/*) feeds it, and nothing here reads a transcript. A row is never a chat: it has no journal, no epoch (0) and no write.
import { nativeChatId, hostIdOfNative, nativeChatIdOfHostChat } from '../../shared/host/nativeChats.mjs';
import { before, cursorOf, firstAfter, placeOf } from './chatIndex.mjs';

/** Native events for one row come at most this often (a terminal appends a line per message); the latest state is what is told when the wait ends. */
export const NATIVE_EVENT_GAP_MS = 2000;
const TITLE_MAX = 200;

/**
 * @typedef {{ family: 'claude' | 'codex', id: string, title?: string, folder?: string, createdAt: number, updatedAt: number, running?: boolean | null, attention?: boolean, app?: 'terminal' | 'desktop' | 'sdk', archived?: boolean, folderMissing?: boolean, format?: 'unknown' }} NativeSession what a discoverer knows of one session, by the agent's own id
 * @typedef {NativeSession & { chatId: string, rev: number }} NativeRow
 */

/**
 * @param {object} o
 * @param {(chatId: string) => boolean} [o.owned] whether this Host runs the chat (`claude:<id>`, or a Codex thread's bare id): such a session is the Host's, never a native row
 * @param {(kind: 'created' | 'changed' | 'removed', chatId: string, rev: number, chat?: object) => void} [o.announce] tells the watchers of a change (the chat index numbers them)
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => any} [o.later] a timer (a test drives it)
 * @param {(timer: any) => void} [o.cancel]
 */
export function createNativeIndex({
  owned = () => false,
  announce = () => undefined,
  now = Date.now,
  later = setTimeout,
  cancel = clearTimeout,
} = {}) {
  /** @type {Map<string, NativeRow>} */
  const rows = new Map();
  /** @type {NativeRow[] | null} */
  let order = null;
  /** The rows watchers have been told of and not told gone, with when each was last told (a row told and then not listed any more must be told gone). @type {Map<string, number>} */
  const told = new Map();
  /** @type {Map<string, any>} */
  const waiting = new Map();

  /** What a client is told of a row: the agent's own id is only in the row's id, and nothing that points into the machine's files is sent. @param {NativeRow} r */
  const wire = ({ family, id, running, attention, title, ...r }) => ({
    ...r,
    title: (title || '').slice(0, TITLE_MAX) || `Session ${id.slice(0, 6)}`,
    harness: family,
    // `null` is a session whose state the agent cannot say (Codex's, until a later slice): not idle
    state: attention ? 'attention' : running === null ? 'unknown' : running ? 'running' : 'idle',
    origin: /** @type {const} */ ('native'),
    readOnly: /** @type {const} */ (true),
    epoch: 0,
  });
  /** Whether a row is listed: not archived (hidden by default) and not a session this Host runs. @param {NativeRow} r */
  const listed = (r) => !r.archived && !owned(hostIdOfNative(r.family, r.id));

  /** @param {'created' | 'changed' | 'removed'} kind @param {NativeRow} row */
  const tell = (kind, row) => {
    const at = now();
    if (kind === 'removed') {
      if (waiting.has(row.chatId)) cancel(waiting.get(row.chatId)), waiting.delete(row.chatId);
      told.delete(row.chatId);
      announce('removed', row.chatId, row.rev);
      return;
    }
    const last = told.get(row.chatId) ?? -Infinity;
    if (at - last >= NATIVE_EVENT_GAP_MS) {
      told.set(row.chatId, at);
      announce(kind, row.chatId, row.rev, wire(row));
      return;
    }
    // a change inside the gap waits, and the row as it is then is what is told, as a change (a client takes an upsert of a row it does not hold as that row)
    if (waiting.has(row.chatId)) return;
    const timer = later(
      () => {
        waiting.delete(row.chatId);
        const now2 = rows.get(row.chatId);
        if (!now2 || !listed(now2)) return;
        told.set(row.chatId, now());
        announce('changed', now2.chatId, now2.rev, wire(now2));
      },
      NATIVE_EVENT_GAP_MS - (at - last),
    );
    timer.unref?.();
    waiting.set(row.chatId, timer);
  };

  /** What a row's `running` says, three-valued: working, not working, or not known (`null`); a session with no word on it is not working. @param {boolean | null | undefined} r */
  const runState = (r) => (r === null ? 'unknown' : r ? 'running' : 'idle');
  /** Whether any shown field differs between two rows. @param {NativeRow} a @param {NativeSession} b */
  const differs = (a, b) =>
    a.title !== b.title ||
    a.folder !== b.folder ||
    a.updatedAt !== b.updatedAt ||
    runState(a.running) !== runState(b.running) ||
    !!a.attention !== !!b.attention ||
    a.app !== b.app ||
    !!a.archived !== !!b.archived ||
    !!a.folderMissing !== !!b.folderMissing ||
    a.format !== b.format;

  const index = {
    /** Adds a session or updates what is known of it; tells the watchers only of a change a row shows. @param {NativeSession} s */
    upsert(s) {
      const chatId = nativeChatId(s.family, s.id);
      const had = rows.get(chatId);
      if (had && !differs(had, s)) return;
      const row = { ...s, chatId, rev: (had?.rev ?? 0) + 1 };
      rows.set(chatId, row);
      order = null;
      const visible = listed(row);
      const wasVisible = !!had && listed(had);
      if (visible) tell(wasVisible ? 'changed' : 'created', row);
      else if (wasVisible && had) tell('removed', row);
    },
    /** The session is gone from the machine (its file was deleted). @param {'claude' | 'codex'} family @param {string} id */
    remove(family, id) {
      const chatId = nativeChatId(family, id);
      const had = rows.get(chatId);
      if (!had || !rows.delete(chatId)) return;
      order = null;
      if (listed(had)) tell('removed', had);
    },
    /** A whole scan of one family: sessions it names are upserted, the family's rows it no longer names are removed. A scan that failed must not call this (it would empty the list). @param {'claude' | 'codex'} family @param {NativeSession[]} sessions */
    replace(family, sessions) {
      const named = new Set(sessions.map((s) => s.id));
      for (const row of [...rows.values()]) if (row.family === family && !named.has(row.id)) index.remove(family, row.id);
      for (const s of sessions) index.upsert({ ...s, family });
    },
    /** A chat on this Host came or went: a session it now runs is told gone to those that were told of it, and one it stopped running is told of again. @param {string} hostChatId the id the Host knows the chat by */
    recheck(hostChatId) {
      const id = nativeChatIdOfHostChat(hostChatId);
      const row = id ? rows.get(id) : undefined;
      if (!row) return;
      if (told.has(row.chatId) && !listed(row)) tell('removed', row);
      else if (!told.has(row.chatId) && listed(row)) tell('created', row);
    },
    /** Whether a row is held under this id (listed or not). @param {string} chatId */
    has: (chatId) => rows.has(chatId),
    /** The session behind a listed id, for the read and adopt that come later; never for a session this Host runs or an archived one. @param {string} chatId */
    get: (chatId) => {
      const row = rows.get(chatId);
      return row && listed(row) ? row : null;
    },
    /** The rows this index lists. */
    get size() {
      let n = 0;
      for (const r of rows.values()) if (listed(r)) n++;
      return n;
    },
    /**
     * One page, newest activity first, from the place a cursor names: empty for a caller whose scope may not see native sessions, so a short page tells nothing of what is there.
     * @param {{ limit: number, cursor?: string }} p @param {import('./chatScope.mjs').ChatScope} [scope]
     * @returns {{ chats: ReturnType<typeof wire>[], next?: string }}
     */
    page({ limit, cursor }, scope) {
      if (!scope?.native) return { chats: [] };
      const place = cursor === undefined ? null : placeOf(cursor);
      if (cursor !== undefined && !place) throw Object.assign(new Error('That is not a place in this list.'), { code: 'bad_cursor' });
      const sorted = (order ??= [...rows.values()].sort((a, b) => (before(a, b) ? -1 : 1)));
      /** @type {NativeRow[]} */
      const got = [];
      for (let i = firstAfter(sorted, place); i < sorted.length && got.length <= limit; i++) {
        const r = /** @type {NativeRow} */ (sorted[i]);
        if (listed(r)) got.push(r);
      }
      const last = got[limit - 1];
      return { chats: got.slice(0, limit).map(wire), ...(got.length > limit && last ? { next: cursorOf(last) } : {}) };
    },
    /** Ends the timers (the Host is closing). */
    close() {
      for (const t of waiting.values()) cancel(t);
      waiting.clear();
    },
  };
  return index;
}
