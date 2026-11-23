// What the user marked on a MoMo task (M0a): done, archived or deleted from view, keyed by the task's stable id and kept through a tiny storage seam, `{ read, change }`, that the app wires to a sealed file (app/momoTaskMarks.cjs) and tests to memory; this module reaches no disk, no Electron and no clock but the ones it is given. Marks are the user's own fact "I marked this": only the Tasks panel's momoTasks:mark and the phone's momo.tasks.mark call `mark`, nothing MoMo does (tests/momoTaskMarks.invariant.test.ts). Entries last 30 days, at most 500; an Undo token (60 s, kept in memory only) puts back what a mark replaced.
const crypto = require('node:crypto');

/** How long a mark is kept; the runs a mark can name are kept no longer. */
const KEEP_MS = 30 * 86_400_000;
/** The most marks kept: the newest. */
const MAX_MARKS = 500;
/** How long an Undo token works. */
const UNDO_MS = 60_000;
const MAX_UNDO = 50;
/** What a request may say, and what is kept for it (reopen keeps nothing). */
const REQUESTS = Object.freeze({ done: 'done', archive: 'archived', delete: 'deleted', reopen: null });
const KEPT = new Set(['done', 'archived', 'deleted']);
/** Only a routine run is marked: a loop is closed through the loop store, a card by answering it. */
const ID = /^run:.{1,190}$/s;

/** @typedef {{ mark: 'done' | 'archived' | 'deleted', at: number }} Mark */
/** @typedef {{ marks: Record<string, Mark> }} MarksValue */
/**
 * The whole storage seam: sealedFile.cjs's SealedJson fits it, tests use `memoryStorage`.
 * @typedef {{ read: () => MarksValue, change: <R>(fn: (v: MarksValue) => R | Promise<R>) => Promise<R> }} MarksStorage
 */

/** A mark error the IPC layers pass on by its code. */
class MarkError extends Error {
  /** @param {string} message @param {'bad_args' | 'expired'} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const valid = (/** @type {string} */ id, /** @type {any} */ m, /** @type {number} */ now) =>
  ID.test(id) && KEPT.has(m?.mark) && Number.isFinite(m?.at) && m.at > now - KEEP_MS;

/**
 * The kept marks: the valid ones, not older than KEEP_MS, the newest MAX_MARKS.
 * @param {unknown} v @param {number} now @returns {MarksValue}
 */
function marksShape(v, now) {
  const raw = /** @type {any} */ (v)?.marks;
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : [];
  const kept = entries
    .filter(([id, m]) => valid(id, m, now))
    .sort((a, b) => /** @type {any} */ (b[1]).at - /** @type {any} */ (a[1]).at)
    .slice(0, MAX_MARKS);
  return { marks: Object.fromEntries(kept) };
}

/** A storage that keeps the value in memory (tests, the dev host's stand-in). @returns {MarksStorage} */
function memoryStorage(/** @type {{ now?: () => number }} */ { now = Date.now } = {}) {
  let value = marksShape(null, now());
  return {
    read: () => marksShape(value, now()),
    change: async (fn) => {
      const next = marksShape(value, now());
      const out = await fn(next);
      value = marksShape(next, now());
      return out;
    },
  };
}

/**
 * @param {{ storage: MarksStorage, now?: () => number, newToken?: () => string }} o
 */
function createTaskMarks({ storage, now = Date.now, newToken = () => crypto.randomUUID() }) {
  /** @type {Map<string, { taskId: string, before: Mark | null, set: Mark | null, until: number }>} */
  const undo = new Map();
  const dropStale = () => {
    for (const [token, u] of undo) if (u.until <= now()) undo.delete(token);
    while (undo.size > MAX_UNDO) undo.delete(/** @type {string} */ (undo.keys().next().value));
  };
  const expired = () => new MarkError('That can’t be undone any more.', 'expired');
  return {
    /** Every mark kept, by task id. */
    list: () => storage.read().marks,

    /**
     * The user's mark on a task, or (with `undoToken`) taking back what that earlier call did while it is still the task's mark.
     * `undoToken` comes back when there is something to take back.
     * @param {unknown} taskId @param {unknown} request done, archive, delete or reopen @param {unknown} [undoToken]
     * @returns {Promise<{ taskId: string, mark: Mark['mark'] | null, undoToken?: string }>}
     */
    async mark(taskId, request, undoToken) {
      if (typeof taskId !== 'string' || !ID.test(taskId)) throw new MarkError('Only a routine run can be marked.', 'bad_args');
      dropStale();
      if (undoToken !== undefined) {
        const u = typeof undoToken === 'string' ? undo.get(undoToken) : undefined;
        if (!u || u.taskId !== taskId) throw expired();
        undo.delete(/** @type {string} */ (undoToken));
        return storage.change((v) => {
          const current = v.marks[taskId];
          const same = u.set ? current?.mark === u.set.mark && current.at === u.set.at : current === undefined;
          // changed again since: the later mark stands
          if (!same) throw expired();
          if (u.before) v.marks[taskId] = u.before;
          else delete v.marks[taskId];
          return { taskId, mark: u.before?.mark ?? null };
        });
      }
      if (typeof request !== 'string' || !Object.hasOwn(REQUESTS, request))
        throw new MarkError('Pick done, archive, delete or reopen.', 'bad_args');
      const kept = REQUESTS[/** @type {keyof typeof REQUESTS} */ (request)];
      return storage.change((v) => {
        const before = v.marks[taskId] ?? null;
        // marking what is marked the same way, or reopening what is open, changes and leaves nothing to take back
        if ((before?.mark ?? null) === kept) return { taskId, mark: kept };
        const set = kept ? { mark: /** @type {Mark['mark']} */ (kept), at: now() } : null;
        if (set) v.marks[taskId] = set;
        else delete v.marks[taskId];
        const token = newToken();
        undo.set(token, { taskId, before, set, until: now() + UNDO_MS });
        return { taskId, mark: kept, undoToken: token };
      });
    },
  };
}

module.exports = { createTaskMarks, marksShape, memoryStorage, MarkError, KEEP_MS, MAX_MARKS, UNDO_MS, MAX_UNDO };
