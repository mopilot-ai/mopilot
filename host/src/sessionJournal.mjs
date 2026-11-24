// Per-chat durable stream storage: checksummed appends, fsynced checkpoints and reserved sequence ranges under the Host data-dir lock.
import fs from 'node:fs';
import { createHistoryPages } from './historyPage.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createJournalItems } from './journalItems.mjs';
import { createSessionBudget } from './sessionBudget.mjs';
import { createSessionRetirement } from './sessionRetirement.mjs';
import { createSessionSummaries } from './sessionSummary.mjs';
import { createRequire } from 'node:module';
// a folder is synced where the system can (electron/platform/folderSync.cjs); a Host runs on Linux and macOS
const { syncFolder } = createRequire(import.meta.url)('../../electron/platform/folderSync.cjs');

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const encode = (value) => {
  const text = JSON.stringify(value);
  return `${hash(text)} ${text}\n`;
};
const count = (n) => Number.isSafeInteger(n) && n >= 0;

export class SessionJournalError extends Error {
  constructor(message, code = 'session_journal_unreadable') {
    super(message);
    this.code = code;
  }
}

/** Decode complete records only; a torn final append is returned separately for safe truncation. */
function decode(text, repairTail = false) {
  const end = text.lastIndexOf('\n') + 1;
  const lines = text.slice(0, end).split('\n').slice(0, -1);
  const rows = [];
  let bytes = 0;
  let torn = end !== text.length;
  for (const [i, line] of lines.entries()) {
    try {
      const body = line.slice(65);
      if (line[64] !== ' ' || hash(body) !== line.slice(0, 64))
        throw new SessionJournalError('A committed journal record failed its checksum.');
      try {
        rows.push(JSON.parse(body));
      } catch {
        throw new SessionJournalError('A committed journal record is not JSON.');
      }
      bytes += Buffer.byteLength(line) + 1;
    } catch (error) {
      if (!repairTail || i !== lines.length - 1) throw error;
      torn = true;
    }
  }
  return { rows, bytes, torn };
}

/**
 * The caller must own the Host's data-dir lock before the first access. No file is touched by construction.
 * @param {{ dataDir: string, io?: typeof fs, report?: (message: string) => void, maxBytes?: number, rotateBytes?: number, reserve?: number, maxTotalBytes?: number, maxCachedChats?: number, listing?: { chunk?: number, writeBack?: number, fillMax?: number }, active?: (chatId: string) => boolean }} o
 */
export function createSessionJournal({
  dataDir,
  io = fs,
  report = console.error,
  maxBytes = 64 * 1024 * 1024,
  rotateBytes = 1024 * 1024,
  reserve = 256,
  maxTotalBytes = 512 * 1024 * 1024,
  maxCachedChats = 128,
  listing = {},
  active = () => false,
}) {
  const root = path.join(dataDir, 'sessions');
  const budget = createSessionBudget({
    root,
    io,
    maxBytes: maxTotalBytes,
    full: () =>
      new SessionJournalError(
        'This machine reached its total saved-chat storage budget. Delete saved chats on this machine before retrying.',
        'session_journal_budget',
      ),
  });
  /** @type {Map<string, any>} */
  const cache = new Map();
  const readHistoryPage = createHistoryPages();
  const syncDir = (dir) => syncFolder(dir, { fs: io });
  const retired = createSessionRetirement({
    root,
    io,
    syncDir,
    deleted: () => new SessionJournalError('This chat was deleted from this machine.', 'session_journal_deleted'),
  });
  /** Replaces a file whole: all of it is seen or none. `durable` false skips the syncs, for a copy that can be rebuilt (a summary). */
  const atomic = (file, text, durable = true) => {
    const tmp = `${file}.next`;
    budget.reserve(tmp, Buffer.byteLength(text));
    const fd = io.openSync(tmp, 'w', 0o600);
    try {
      io.writeFileSync(fd, text);
      if (durable) io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    io.renameSync(tmp, file);
    budget.renamed(tmp, file);
    if (durable) syncDir(path.dirname(file));
  };
  const read = (file) => {
    try {
      return io.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };
  const summaries = createSessionSummaries({
    io,
    root,
    report,
    atomic,
    uncertain: () => budget.invalidate(),
    peek: (chatId) => peek(chatId),
    ...listing,
    encode,
    decode,
    count,
    hash,
    read,
    retired,
    loaded: (chatId) => cache.has(chatId),
  });
  const project = (s, row, apply = true) => {
    if (!row || !count(row.n) || row.n !== s.n + 1) throw new SessionJournalError('The journal has a missing or unordered record.');
    if (row.kind === 'reserve' && count(row.to) && row.to > s.reserved) {
      if (apply) s.reserved = row.to;
    } else if (
      row.kind === 'durable' &&
      count(row.frame?.seq) &&
      row.frame.seq <= s.reserved &&
      row.frame.seq > (s.frames.at(-1)?.seq ?? 0) &&
      row.frame.rev === s.frames.length + 1 &&
      row.frame.item &&
      typeof row.frame.item === 'object'
    ) {
      if (apply) {
        s.frames.push(row.frame);
        s.index?.add(row.frame);
      }
    } else if (row.kind === 'state' && row.patch && typeof row.patch === 'object' && !Array.isArray(row.patch)) {
      if (apply) s.state = { ...s.state, ...row.patch };
    } else throw new SessionJournalError('The journal contains an invalid record.');
    if (apply) s.n = row.n;
  };
  const checkpoint = (s) =>
    encode({ version: 1, chatId: s.chatId, generation: s.generation, n: s.n, reserved: s.reserved, frames: s.frames, state: s.state });
  /** A checkpoint's text, read and checked the one way every reader checks it (a load and the list's title search): throws when it is torn, corrupt, from another version or not this chat's. @param {string} saved @param {string} chatId */
  const checkpointOf = (saved, chatId) => {
    const decoded = decode(saved);
    const s = decoded.rows[0];
    if (
      decoded.torn ||
      decoded.rows.length !== 1 ||
      s?.version !== 1 ||
      s.chatId !== chatId ||
      typeof s.generation !== 'string' ||
      !s.generation ||
      !count(s.n) ||
      !count(s.reserved) ||
      !Array.isArray(s.frames) ||
      !s.state ||
      typeof s.state !== 'object' ||
      Array.isArray(s.state)
    )
      throw new SessionJournalError('The session checkpoint is corrupt or from an unsupported version.');
    let seq = 0;
    for (const [i, frame] of s.frames.entries()) {
      if (
        !frame ||
        frame.rev !== i + 1 ||
        !count(frame.seq) ||
        frame.seq <= seq ||
        frame.seq > s.reserved ||
        !frame.item ||
        typeof frame.item !== 'object'
      )
        throw new SessionJournalError('The checkpoint contains invalid durable history.');
      seq = frame.seq;
    }
    return s;
  };
  const loadRaw = (chatId) => {
    retired.check(chatId);
    if (cache.has(chatId)) {
      const held = cache.get(chatId);
      cache.delete(chatId);
      cache.set(chatId, held);
      return held;
    }
    if (cache.size >= maxCachedChats) {
      const victim = [...cache].find(([id, entry]) => entry.persisted && !entry.failure && !active(id));
      if (!victim)
        throw new SessionJournalError(
          'This machine reached its loaded-chat limit. Finish a pending chat or restart the Host after repairing its storage, then retry.',
          'session_journal_busy',
        );
      cache.delete(victim[0]);
    }
    const dir = path.join(root, hash(chatId));
    const file = path.join(dir, 'checkpoint');
    const log = path.join(dir, 'events');
    let s;
    const saved = read(file);
    if (saved === null) {
      if (read(log) !== null) throw new SessionJournalError('The session checkpoint is missing; history was not discarded.');
      s = { version: 1, chatId, generation: crypto.randomUUID(), n: 0, reserved: 0, frames: [], state: {} };
    } else {
      s = checkpointOf(saved, chatId);
    }
    const text = read(log) ?? '';
    const decoded = decode(text, true);
    for (const row of decoded.rows) {
      if (!row || !count(row.n)) throw new SessionJournalError('The journal contains an invalid record number.');
      if (row.n > s.n) project(s, row);
    }
    if (decoded.torn) {
      io.truncateSync(log, decoded.bytes);
      budget.invalidate();
      const fd = io.openSync(log, 'r+');
      try {
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      report(`Recovered a torn final session append for ${chatId}; committed history was retained.`);
    }
    s = {
      ...s,
      dir,
      file,
      log,
      persisted: saved !== null,
      bytes: decoded.bytes,
      checkpointBytes: Buffer.byteLength(checkpoint(s)),
      seq: s.reserved,
      failure: null,
      index: createJournalItems(s.frames),
    };
    cache.set(chatId, s);
    if (s.persisted) summaries.load(s);
    return s;
  };
  /**
   * A chat's state read from its checkpoint and events without putting the chat in the journal's cache and without touching its files (a torn tail is
   * left as it is, not repaired). The chat list uses it to find a title, and has judged the size first. Null when the chat has no checkpoint (also when it
   * has events but no checkpoint, which a load refuses: the chat is then left as it is); a corrupt journal throws, with the same checks as a load.
   * @param {string} chatId
   */
  const peek = (chatId) => {
    const dir = path.join(root, hash(chatId));
    const file = path.join(dir, 'checkpoint');
    const log = path.join(dir, 'events');
    const saved = read(file);
    if (saved === null) return null;
    const s = checkpointOf(saved, chatId);
    for (const row of decode(read(log) ?? '', true).rows) {
      if (!row || !count(row.n)) throw new SessionJournalError('The journal contains an invalid record number.');
      if (row.n > s.n) project(s, row);
    }
    return s.state;
  };
  const load = (chatId) => {
    try {
      return loadRaw(chatId);
    } catch (error) {
      if (error instanceof SessionJournalError) throw error;
      report(`Session storage read failed: ${error.message}`);
      throw new SessionJournalError(
        'This machine cannot read the chat journal. Check its disk space and permissions.',
        'session_journal_unreadable',
      );
    }
  };
  const append = (s, body) => {
    const row = { ...body, n: s.n + 1 };
    const text = encode(row);
    try {
      project(s, row, false);
      // Estimate the checkpoint delta from this row, not by cloning/stringifying all historical frames.
      let growth = String(row.n).length - String(s.n).length;
      if (body.kind === 'reserve') growth += String(body.to).length - String(s.reserved).length;
      if (body.kind === 'durable') growth += Buffer.byteLength(JSON.stringify(body.frame)) + (s.frames.length ? 1 : 0);
      if (body.kind === 'state')
        growth += Buffer.byteLength(JSON.stringify({ ...s.state, ...body.patch })) - Buffer.byteLength(JSON.stringify(s.state));
      const size = s.checkpointBytes + growth;
      if (size + Buffer.byteLength(text) > maxBytes)
        throw new SessionJournalError('This chat journal is full; export or remove history before retrying.', 'session_journal_full');
      if (!s.persisted) {
        io.mkdirSync(s.dir, { recursive: true, mode: 0o700 });
        atomic(s.file, checkpoint(s));
        syncDir(root);
        syncDir(dataDir);
        s.persisted = true;
        summaries.keep(s);
      }
      const rotate = s.bytes + Buffer.byteLength(text) > rotateBytes || s.checkpointBytes + s.bytes + Buffer.byteLength(text) > maxBytes;
      if (rotate) {
        atomic(s.file, checkpoint(s));
        atomic(s.log, '');
        s.bytes = 0;
      }
      const created = !io.existsSync(s.log);
      budget.reserve(s.log, Buffer.byteLength(text), true);
      const fd = io.openSync(s.log, 'a', 0o600);
      try {
        io.writeFileSync(fd, text);
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      if (created) syncDir(s.dir);
      project(s, row);
      s.checkpointBytes = size;
      s.bytes += Buffer.byteLength(text);
      s.failure = null;
      if (
        body.kind === 'state' &&
        (body.patch.title !== undefined ||
          body.patch.harness !== undefined ||
          body.patch.origin !== undefined ||
          body.patch.attention !== undefined)
      )
        summaries.keep(s);
    } catch (e) {
      budget.invalidate();
      s.failure =
        e instanceof SessionJournalError
          ? e
          : new SessionJournalError(
              'This machine could not save the chat. Check its disk space and permissions, then retry.',
              'session_journal_write_failed',
            );
      throw s.failure;
    }
  };
  const writable = (chatId) => {
    const s = load(chatId);
    if (!s.failure) return s;
    cache.delete(chatId);
    try {
      const restored = load(chatId);
      const fd = io.openSync(restored.log, 'r+');
      try {
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      return restored;
    } catch (error) {
      cache.set(chatId, s);
      throw error;
    }
  };
  return {
    deleted(chatId) {
      return retired.has(chatId);
    },
    /** Idempotent durable identity from acknowledged or adopted disk rows. @param {string} chatId @param {any} item */
    seen(chatId, item) {
      return writable(chatId).index.seen(item);
    },
    /** Last durable terminal and completed text, independent of a volatile turn map. @param {string} chatId @param {string} turnId */
    turn(chatId, turnId) {
      return structuredClone(writable(chatId).index.turn(turnId) ?? null);
    },
    /** Constant-time revision lookup; serialization is only for snapshots or rotation. @param {string} chatId */
    head(chatId) {
      const s = writable(chatId);
      return { rev: s.frames.length, failure: s.failure };
    },
    /** A fsynced capacity/health probe before dispatching an agent. @param {string} chatId */
    check(chatId, inputBytes = 0) {
      const s = writable(chatId);
      budget.check(inputBytes);
      if (s.checkpointBytes + inputBytes > maxBytes)
        throw new SessionJournalError(
          'This chat journal is full; start a new chat or remove saved history before retrying.',
          'session_journal_full',
        );
      append(s, { kind: 'reserve', to: s.reserved + reserve });
    },
    history(p) {
      return readHistoryPage(load(p.chatId), p);
    },
    /** A copy; callers cannot mutate the authoritative history. @param {string} chatId */
    read(chatId) {
      const s = load(chatId);
      return structuredClone({
        generation: s.generation,
        seq: s.seq,
        rev: s.frames.length,
        frames: s.frames,
        state: s.state,
        ...(s.failure ? { storageError: { code: s.failure.code, message: s.failure.message } } : {}),
      });
    },
    /** Parent context is bounded even if the journal would need to be read from disk. */
    recentItems(chatId, limit, maxColdBytes = 16 * 1024 * 1024) {
      if (!cache.has(chatId)) {
        const dir = path.join(root, hash(chatId));
        const bytes = ['checkpoint', 'events'].reduce(
          (sum, name) => sum + (io.statSync(path.join(dir, name), { throwIfNoEntry: false })?.size ?? 0),
          0,
        );
        if (bytes > maxColdBytes) {
          retired.check(chatId);
          return { items: [], total: 0, omittedForSize: true };
        }
      }
      const { frames } = load(chatId);
      return { items: structuredClone(frames.slice(-limit).map((frame) => frame.item)), total: frames.length };
    },
    /** Reserve before allocating: recovery skips unused numbers, never reuses a published delta's sequence. @param {string} chatId */
    next(chatId) {
      const s = writable(chatId);
      if (s.seq === s.reserved) append(s, { kind: 'reserve', to: s.reserved + reserve });
      return ++s.seq;
    },
    /** @param {string} chatId @param {{seq: number, rev: number, item: object, promotes?: string}} frame */
    durable(chatId, frame) {
      append(writable(chatId), { kind: 'durable', frame: structuredClone(frame) });
    },
    /** Only the latest state projection survives, never the ephemeral frame itself. @param {string} chatId @param {object} patch */
    state(chatId, patch) {
      append(writable(chatId), { kind: 'state', patch: structuredClone(patch) });
    },
    /** A removed chat must not revive from a checkpoint left by a crash halfway through deletion. @param {string} chatId */
    remove(chatId) {
      try {
        retired.remove(chatId);
      } catch {
        throw new SessionJournalError(
          'This machine could not delete the chat. Check its disk space and permissions, then retry.',
          'session_journal_delete_failed',
        );
      } finally {
        budget.invalidate();
        cache.delete(chatId);
      }
    },
    /** Every chat this Host holds, newest activity first (see sessionSummary.mjs). */
    chats: () => summaries.list(),
    /** Finds a stand-in chat's title from its journal (see sessionSummary.mjs). @param {string} chatId @param {number} [budget] */
    fillTitle: (chatId, budget) => summaries.fill(chatId, budget),
    /** Only a durable inactive projection can be reconstructed without losing its identity. */
    evictable(chatId) {
      const s = cache.get(chatId);
      return !s || (s.persisted && !s.failure);
    },
  };
}
