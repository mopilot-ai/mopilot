// What the chat list (`host.chats`) reads without opening a journal: a small checksummed `summary` file beside each chat's checkpoint (the chat's id, when it began, its title and the agent it runs on), kept best effort, and the listing built from them.
import path from 'node:path';

/** A chat's id as its checkpoint's first line spells it (`<sha256> {"version":1,"chatId":"…`), found without reading the rest of the file. */
const HEAD = /^[0-9a-f]{64} \{"version":1,"chatId":("(?:[^"\\]|\\.)*")/;
/** How many summaries one list call writes for chats that had none: the rest are written by the next calls, so one request never holds the journal for long. */
const WRITE_BACK = 100;
/** How many folders one list reads before it lets the event loop go. */
const CHUNK = 200;
/** The journals a title is looked for in are at most this big (checkpoint and events together); a bigger one gets its title when it is opened. A call also has a total budget (chatList.mjs), so a few big journals do not make one call long. */
const FILL_MAX_BYTES = 8 * 1024 * 1024;
/** How much of a checkpoint's start is read to find the chat id. */
const HEAD_BYTES = 4096;
/** The folder a chat was started in and who started it, as its state carries them. @param {any} state */
const originOf = (state) => ({
  ...(typeof state?.origin?.folder === 'string' ? { folder: state.origin.folder } : {}),
  ...(typeof state?.origin?.by === 'string' ? { by: state.origin.by.slice(0, 80) } : {}),
  ...(typeof state?.origin?.fp === 'string' ? { fp: state.origin.fp } : {}),
  // what still holds after a restart (a paused or blocked chat, a missing credential), never a card, which a restart closes
  ...(typeof state?.attention?.kind === 'string' && state.attention.kind !== 'approval' ? { attn: state.attention.kind } : {}),
});
/** The title a chat's state carries: its own name, else the cut-short one it replaces. @param {any} state */
const titleOf = (state) => String(state?.title?.name || state?.title?.provisional || '').slice(0, 200);

/**
 * @param {object} o
 * @param {any} o.io the file system
 * @param {string} o.root the sessions folder
 * @param {(message: string) => void} o.report
 * @param {(file: string, text: string, durable?: boolean) => void} o.atomic the journal's own budgeted write: synced unless `durable` is false
 * @param {number} [o.chunk] how many folders one list reads before it lets the event loop go
 * @param {number} [o.fillMax] the most a journal may hold (checkpoint and events) for its title to be looked for
 * @param {number} [o.writeBack] how many summaries one list writes for chats that had none
 * @param {(chatId: string) => any} o.peek a chat's state from its journal, read without caching or repair
 * @param {() => void} o.uncertain tells the journal's budget that a write did not finish, so it reads the folders again
 * @param {(value: unknown) => string} o.encode
 * @param {(text: string) => { rows: any[], torn: boolean }} o.decode
 * @param {(n: unknown) => boolean} o.count
 * @param {(text: string) => string} o.hash
 * @param {(file: string) => string | null} o.read
 * @param {{ has: (chatId: string) => boolean }} o.retired the deletion tombstones
 * @param {(chatId: string) => boolean} o.loaded whether the journal holds the chat in memory (it then keeps its own summary)
 */
export function createSessionSummaries({
  io,
  root,
  report,
  atomic,
  encode,
  decode,
  count,
  hash,
  read,
  retired,
  loaded,
  uncertain,
  peek,
  chunk = CHUNK,
  writeBack = WRITE_BACK,
  fillMax = FILL_MAX_BYTES,
}) {
  /** A summary file's content, or null when it is missing, torn, malformed or not for this chat. @param {string} file @param {string | null} [chatId] */
  const readSummary = (file, chatId = null) => {
    try {
      const text = read(file);
      if (text === null) return null;
      const { rows, torn } = decode(text);
      const row = rows[0];
      if (
        torn ||
        rows.length !== 1 ||
        row?.v !== 1 ||
        typeof row.chatId !== 'string' ||
        !count(row.createdAt) ||
        typeof row.title !== 'string'
      )
        return null;
      if (row.harness !== undefined && typeof row.harness !== 'string') return null;
      if (row.provisional !== undefined && row.provisional !== true) return null;
      if (
        (row.folder !== undefined && typeof row.folder !== 'string') ||
        (row.by !== undefined && typeof row.by !== 'string') ||
        (row.fp !== undefined && typeof row.fp !== 'string') ||
        (row.attn !== undefined && typeof row.attn !== 'string')
      )
        return null;
      return chatId !== null && row.chatId !== chatId ? null : row;
    } catch {
      return null;
    }
  };
  /** When a chat began: its folder's creation (made once, at the first save; the checkpoint is replaced at every rotation, so its own birth is not the chat's). A file system with no birth time gives 0, then the oldest write time in the folder says. @param {string} name the folder */
  const born = (name) => {
    const dir = path.join(root, name);
    try {
      const at = Math.round(io.statSync(dir).birthtimeMs);
      if (at > 0) return at;
    } catch {
      // the folder's files say
    }
    let oldest = 0;
    try {
      for (const f of io.readdirSync(dir)) {
        try {
          const at = Math.round(io.statSync(path.join(dir, f)).mtimeMs);
          if (at > 0 && (!oldest || at < oldest)) oldest = at;
        } catch {
          // gone since the listing
        }
      }
    } catch {
      // no folder: the chat is dated now
    }
    return oldest || Date.now();
  };
  /** The id and start of a chat written before summaries existed, from its checkpoint's first bytes; null when the folder is not a chat's. @param {string} name the folder, which is the hash of the id */
  const legacy = (name) => {
    try {
      const file = path.join(root, name, 'checkpoint');
      const fd = io.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const found = HEAD.exec(buf.toString('utf8', 0, io.readSync(fd, buf, 0, HEAD_BYTES, 0)));
        const chatId = found ? JSON.parse(found[1]) : null;
        return typeof chatId === 'string' && hash(chatId) === name ? { chatId, title: '', createdAt: born(name) } : null;
      } finally {
        io.closeSync(fd);
      }
    } catch {
      return null;
    }
  };
  /** Chats whose journal could not be read for a title: not tried again until the Host restarts (a load, which reports the real error, still can). @type {Set<string>} */
  const unreadable = new Set();
  return {
    /** Writes the summary when it changed. Never fails the chat: a write that cannot be made is reported and the chat is simply listed later. @param {any} s the journal's loaded chat */
    keep(s) {
      try {
        const prev = s.summary;
        const harness = typeof s.state?.harness === 'string' ? s.state.harness : undefined;
        const next = {
          v: 1,
          chatId: s.chatId,
          createdAt: prev?.createdAt ?? Date.now(),
          title: titleOf(s.state),
          ...(harness ? { harness } : {}),
          ...originOf(s.state),
        };
        if (
          prev &&
          prev.title === next.title &&
          prev.harness === harness &&
          prev.folder === next.folder &&
          prev.by === next.by &&
          prev.fp === next.fp &&
          prev.attn === next.attn
        )
          return;
        atomic(path.join(s.dir, 'summary'), encode(next));
        s.summary = next;
      } catch (error) {
        uncertain();
        report(`Could not keep the chat summary for ${s.chatId}: ${error.message}`);
      }
    },
    /** Reads a loaded chat's summary, and makes one for a chat that has none (written before they existed: it began about when its folder did). @param {any} s */
    load(s) {
      const prior = readSummary(path.join(s.dir, 'summary'), s.chatId);
      // a stand-in the list wrote (no title: it only had the checkpoint's first bytes) never stands: the chat's own state replaces it
      s.summary = prior && !prior.provisional ? prior : { createdAt: prior?.createdAt ?? born(path.basename(s.dir)) };
      this.keep(s);
    },
    /**
     * Finds the title of a chat that has only a stand-in summary, from its journal (checkpoint and events, read without caching the chat), and writes
     * it as a real, synced summary. One step with no await, so a delete cannot come between the check and the write. Never for a deleted chat; a
     * journal over `FILL_MAX_BYTES`, one that cannot be read or one the journal holds is left with its stand-in (`deferred`: it gets its title when
     * it is opened) and nothing is written, so a failed read never leaves a blank title that looks real.
     * @param {string} chatId @param {number} [budget] the most bytes of journal this call may still read
     * @returns {{ status: 'filled', bytes: number, title: string, harness?: string } | { status: 'done', title: string, harness?: string } | { status: 'gone' | 'deferred' | 'later', writeFailed?: true }}
     */
    fill(chatId, budget = Infinity) {
      if (retired.has(chatId)) return { status: 'gone' };
      const name = hash(chatId);
      const file = path.join(root, name, 'summary');
      const prior = readSummary(file, chatId);
      // another call has made it real since this one listed it
      if (prior && !prior.provisional) return { status: 'done', title: prior.title, ...(prior.harness ? { harness: prior.harness } : {}) };
      if (loaded(chatId) || unreadable.has(chatId)) return { status: 'deferred' };
      const sizeOf = (/** @type {string} */ f) => {
        try {
          return io.statSync(path.join(root, name, f)).size;
        } catch {
          return 0;
        }
      };
      const bytes = sizeOf('checkpoint') + sizeOf('events');
      if (bytes > fillMax) return { status: 'deferred' };
      // too much for what this call may still read: a later call (with its own budget) takes it
      if (bytes > budget) return { status: 'later' };
      /** @type {any} */
      let state;
      try {
        state = peek(chatId);
      } catch (error) {
        // the journal itself cannot be read: not tried again (a load reports the real error); nothing here touched the budget
        unreadable.add(chatId);
        report(`Could not find the title of chat ${chatId}: ${error.message}`);
        return { status: 'deferred' };
      }
      if (state === null) return { status: 'deferred' };
      const harness = typeof state.harness === 'string' ? state.harness : undefined;
      const next = {
        v: 1,
        chatId,
        createdAt: prior?.createdAt ?? born(name),
        title: titleOf(state),
        ...(harness ? { harness } : {}),
        ...originOf(state),
      };
      try {
        atomic(file, encode(next));
      } catch (error) {
        // the write failed (a full disk or budget), not the read: the chat is asked again later, and the caller stops filling for this call
        uncertain();
        report(`Could not keep the title of chat ${chatId}: ${error.message}`);
        return { status: 'deferred', writeFailed: true };
      }
      return { status: 'filled', bytes, title: next.title, ...(harness ? { harness } : {}) };
    },
    /**
     * The chats this Host holds, newest activity first (`updatedAt` is the journal's last write, so nothing is written per frame): every one, since
     * what a client may see is decided by the caller before it cuts the list. A chat without a readable summary is listed from its checkpoint's first
     * bytes with no title, and its summary is written then (at most 100 a call, not synced since it holds nothing a sync would save, never
     * for a chat the journal holds in memory, and none after the first write that fails), so the first bytes of a checkpoint are read once. A deleted
     * chat is never listed. The folders are read in chunks with the event loop let go between them, so a Host with many chats keeps streaming.
     * A row that only has a stand-in summary (no title yet) says `standIn`: `fill` finds its title.
     * @returns {Promise<{ chatId: string, title: string, harness?: string, standIn?: true, createdAt: number, updatedAt: number }[]>}
     */
    async list() {
      /** @type {{ chatId: string, title: string, harness?: string, standIn?: true, createdAt: number, updatedAt: number }[]} */
      const rows = [];
      let names = [];
      try {
        names = io.readdirSync(root);
      } catch {
        return rows;
      }
      let written = 0;
      let failed = false;
      for (const [i, name] of names.entries()) {
        if (i > 0 && i % chunk === 0) await new Promise((resolve) => setImmediate(resolve));
        if (!/^[0-9a-f]{64}$/.test(name)) continue;
        let row = readSummary(path.join(root, name, 'summary'));
        let standIn = !!row?.provisional;
        if (!row) {
          standIn = true;
          row = legacy(name);
          // checked and written in one step: a chat deleted while the loop was let go is skipped here
          if (row && !failed && written < writeBack && !retired.has(row.chatId) && !loaded(row.chatId)) {
            written++;
            try {
              atomic(path.join(root, name, 'summary'), encode({ v: 1, ...row, provisional: true }), false);
            } catch (error) {
              failed = true;
              uncertain();
              report(`Could not keep chat summaries while listing (${row.chatId}): ${error.message}`);
            }
          }
        }
        if (!row || hash(row.chatId) !== name || retired.has(row.chatId)) continue;
        let updatedAt = row.createdAt;
        for (const f of ['events', 'checkpoint']) {
          try {
            updatedAt = Math.max(updatedAt, Math.round(io.statSync(path.join(root, name, f)).mtimeMs));
            break;
          } catch {
            // the next file says when it was last written
          }
        }
        rows.push({
          chatId: row.chatId,
          title: row.title,
          ...(row.harness ? { harness: row.harness } : {}),
          ...(row.folder ? { folder: row.folder } : {}),
          ...(row.by ? { startedBy: row.by } : {}),
          ...(row.fp ? { byFp: row.fp } : {}),
          ...(row.attn ? { attn: row.attn } : {}),
          ...(standIn ? { standIn: true } : {}),
          createdAt: row.createdAt,
          updatedAt,
        });
      }
      return rows.sort((a, b) => b.updatedAt - a.updatedAt || (a.chatId < b.chatId ? -1 : 1));
    },
  };
}
