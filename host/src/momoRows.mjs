// The rows MoMo's chat holds beyond what the harness says (shared/momoView.ts `MomoChatRow`: approval, question, result, watch-changed…): one durable store on the home, written once per id and read by `host.momoRows`, so a card a task or the gate raises reaches every client and survives a restart or a move.

import { HostRefusal } from './hostFs.mjs';
import crypto from 'node:crypto';

/** How many settled rows the store keeps, newest by when they were written; an open card (a pending approval or question) is never counted or evicted by this. */
export const ROWS_KEEP = 500;
/** How many open cards the store holds: a newer one beyond this ends the oldest as `void`, never silently drops it. */
export const PENDING_KEEP = 100;
/** The most rows one read answers; the answer says when there are more. */
export const PAGE = 100;
/** The longest a field of a row built here may be (characters), and the most files a result lists. */
export const CAPS = { title: 300, summary: 2000, evidence: 2000, checked: 1000, detail: 600, file: 300, files: 50, id: 100, action: 100 };

/** @param {any} v */
export const rowsShape = (v) => ({
  rows: Array.isArray(v?.rows)
    ? v.rows.filter((/** @type {any} */ r) => r && typeof r.id === 'string' && typeof r.kind === 'string' && Number.isFinite(r.written))
    : [],
});

/** @param {unknown} v @param {number} n text of at most n characters */
const cut = (v, n) => String(v ?? '').slice(0, n);

/** A machine as the view shows it: the id, and its name when this Host knows it (the id otherwise). @param {string} machineId @param {(id: string) => string | null} nameOf */
const machineOf = (machineId, nameOf) => ({ machineId: cut(machineId, CAPS.id), name: cut(nameOf(machineId) ?? machineId, CAPS.title) });

/** Whether a row is a card still waiting for an answer. @param {any} r */
const isOpen = (r) =>
  (r.kind === 'approval' && r.approval?.status === 'pending') || (r.kind === 'question' && r.question?.status === 'pending');

/** The card ended without an answer: its home can no longer take one. @param {any} r */
const voided = (r) => ({
  ...r,
  ...(r.kind === 'approval' ? { approval: { ...r.approval, status: 'void' } } : { question: { ...r.question, status: 'void' } }),
});

/**
 * The row a task's settled card becomes. The text came from a session, so it is data (`untrusted`) and is cut to a size a row may have.
 * @param {any} card a task core `ResultCard` @param {(id: string) => string | null} nameOf
 */
export function resultRow(card, nameOf) {
  return {
    kind: /** @type {const} */ ('result'),
    id: `result:${cut(card.itemId, CAPS.id)}:${Number(card.settle)}`,
    result: {
      taskId: cut(card.itemId, CAPS.id),
      settle: Number(card.settle),
      title: cut(card.title, CAPS.title),
      state: cut(card.state ?? 'done', 20),
      summary: cut(card.summary, CAPS.summary),
      files: Array.isArray(card.files) ? card.files.slice(0, CAPS.files).map((/** @type {unknown} */ f) => cut(f, CAPS.file)) : [],
      evidence: cut(card.evidence, CAPS.evidence),
      checked: cut(card.checked, CAPS.checked),
      machine: machineOf(String(card.machineId ?? ''), nameOf),
      sessionId: typeof card.sessionId === 'string' ? cut(card.sessionId, CAPS.id) : null,
      untrusted: /** @type {const} */ (true),
      actions: Array.isArray(card.actions)
        ? card.actions
            .slice(0, 10)
            .map((/** @type {any} */ a) => ({ id: cut(a?.id ?? a?.action, CAPS.action), label: cut(a?.label, CAPS.action) }))
        : [],
    },
  };
}

/**
 * The row a watch notice becomes. Its id is a hash of the sink's key, which carries the notice's own text, so no text of a session is in an id.
 * @param {any} notice a task core `WatchNotice` @param {string} key the sink's key for it @param {(id: string) => string | null} nameOf
 */
export function watchRow(notice, key, nameOf) {
  return {
    kind: /** @type {const} */ ('watch-changed'),
    id: `watch:${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24)}`,
    watch: {
      taskId: cut(notice.itemId, CAPS.id),
      title: cut(notice.title, CAPS.title),
      detail: cut(notice.detail, CAPS.detail),
      machine: machineOf(String(notice.machineId ?? ''), nameOf),
    },
  };
}

/**
 * @param {object} o
 * @param {{ read: () => { rows: any[] }, change: (fn: (v: { rows: any[] }) => unknown) => Promise<unknown> }} o.store the durable record, sealed with MoMo's data key (`home.data.sealed`)
 * @param {() => number} [o.now]
 * @param {() => unknown} [o.stamp] this Host's lease while it is the running home (null otherwise)
 * @param {() => boolean} [o.hasChat] whether MoMo has a main chat to put a row in
 * @param {(id: string) => string | null} [o.nameOf] a machine's display name by id
 */
export function createMomoRows({ store, now = Date.now, stamp = () => ({}), hasChat = () => true, nameOf = () => null }) {
  /** @type {Set<(row: object) => void>} */
  const listeners = new Set();
  const away = () => new HostRefusal('momo_home_away', 'This machine is not where MoMo runs now.');
  /** Rows kept to their limits: an open card is never evicted (one too many ends the oldest as void), and the oldest settled rows go first. @param {any[]} rows @param {() => number} next @returns {any[]} */
  const trimmed = (rows, next) => {
    const open = rows.filter(isOpen).sort((a, b) => a.written - b.written);
    // a card ended here is a change the clients must read again: it gets a new place in the order
    const ended = new Map(open.slice(0, Math.max(0, open.length - PENDING_KEEP)).map((r) => [r.id, { ...voided(r), written: next() }]));
    const all = rows.map((r) => ended.get(r.id) ?? r);
    const settled = all.filter((r) => !isOpen(r)).sort((a, b) => a.written - b.written);
    const drop = new Set(settled.slice(0, Math.max(0, settled.length - ROWS_KEEP)).map((r) => r.id));
    return all.filter((r) => !drop.has(r.id)).sort((a, b) => a.written - b.written);
  };
  return {
    /**
     * Write a row by its id: the same id again replaces it (a card that was answered), and a row identical to the one kept is not written again. Only the running
     * home writes (checked again inside the write, which may wait for the file's lock), and only when it has a chat. The time a row is written with is above every
     * time already stored, whatever this machine's clock says after a restart or a move.
     * @param {{ id: string, kind: string, at?: number } & Record<string, unknown>} row @returns {Promise<object>} the row as kept
     */
    async put(row) {
      if (!stamp()) throw away();
      if (!hasChat()) throw new HostRefusal('momo_chat_unavailable', "MoMo's chat can't take this yet.");
      /** @type {any} */
      let kept;
      await store.change((v) => {
        if (!stamp()) throw away();
        let top = v.rows.reduce((m, r) => Math.max(m, r.written), 0);
        const next = () => (top = Math.max(now(), top + 1));
        const found = v.rows.find((r) => r.id === row.id);
        const body = { ...row, at: found?.at ?? row.at ?? now() };
        if (found && JSON.stringify({ ...found, written: 0 }) === JSON.stringify({ ...body, written: 0 })) return void (kept = found);
        kept = { ...body, written: next() };
        v.rows = trimmed([...v.rows.filter((r) => r.id !== row.id), kept], next);
      });
      for (const fn of listeners) {
        try {
          fn(kept);
        } catch (error) {
          void error; // a listener's own failure is its own
        }
      }
      return kept;
    },
    /**
     * The rows written or changed after `after` (all when none), oldest first, at most one page, with the cursor to ask from next and whether more follow.
     * Only the running home answers: a Host that stopped being the home shows nothing of what it held.
     * @param {number} [after] @param {number} [limit]
     */
    list(after = 0, limit = PAGE) {
      if (!stamp()) throw away();
      const later = store
        .read()
        .rows.filter((r) => r.written > after)
        .sort((a, b) => a.written - b.written);
      const page = later.slice(0, Math.min(Math.max(1, limit), PAGE));
      return {
        rows: page.map(({ written: _written, ...row }) => row),
        next: page.at(-1)?.written ?? after,
        more: later.length > page.length,
      };
    },
    /** Told of each row written or changed; returns how to stop. @param {(row: object) => void} fn */
    onRow(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /**
     * What the services' chat sink writes (./momoSeams.mjs `writeRow`): the task core's card and notice, as the rows they become.
     * @param {{ kind: 'result' | 'watch', key: string, body: any }} r
     */
    async writeRow({ kind, key, body }) {
      await this.put(kind === 'result' ? resultRow(body, nameOf) : watchRow(body, key, nameOf));
    },
    /** One settled row written straight to the store, so the travel check has a file of rows to open on the target (no chat needed, nothing told to a client). Tests and the check call it; a running home never does. */
    async seed() {
      await store.change((v) => {
        const top = v.rows.reduce((m, r) => Math.max(m, r.written), 0);
        v.rows = [
          ...v.rows.filter((r) => r.id !== 'seed:rows'),
          {
            kind: 'question',
            id: 'seed:rows',
            at: now(),
            question: { id: 'seed', title: 'seed', body: '', options: [], expiresAt: null, status: 'void', answer: null },
            written: Math.max(now(), top + 1),
          },
        ];
      });
    },
  };
}
