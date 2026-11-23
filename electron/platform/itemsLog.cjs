// threads/<id>.items.jsonl: Sage's own transcript of a basic-tier chat, appended through the transcript writer and read with what it has not written yet.
const fs = require('node:fs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');
const { TranscriptWriter } = require('./transcriptWriter.cjs');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');
const { labeled } = require('../perf/stalls.cjs');

/** A transcript's records, one per line: torn, corrupt or non-object lines are skipped, with one diagnostic per read. */
function recordsOf(text) {
  return labeled('items.parse', () => linesOf(text));
}

/** Note how many lines of a transcript could not be read, if any. Without their text: it is the user's. @param {number} torn */
function noteTorn(torn) {
  if (torn) noteIgnored("read a chat's transcript", `${torn} unreadable line${torn === 1 ? '' : 's'} skipped`);
}

/** recordsOf's work, one synchronous slice of main however long the transcript is. */
function linesOf(text) {
  const out = [];
  let torn = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseJsonRecord(line);
    if (parsed.ok) out.push(parsed.record);
    else torn++;
  }
  // without the line's text
  noteTorn(torn);
  return out;
}

/** How long a run of streamed text chunks is held to become one record; a crash loses at most this much of an unfinished item. */
const COALESCE_MS = 250;
const CHUNK_KINDS = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']);

/** Whether an `update` record is a plain text chunk (nothing but its kind, text and message id), which merges with the next one. */
function isTextChunk(rec) {
  const u = rec?.t === 'update' ? rec.update : null;
  if (!u || !CHUNK_KINDS.has(u.sessionUpdate) || u.content?.type !== 'text' || typeof u.content.text !== 'string') return false;
  return Object.keys(u).every((k) => k === 'sessionUpdate' || k === 'content' || k === 'messageId') && Object.keys(u.content).length === 2;
}

/** The chunk a record continues: same kind, turn and message, so one record reads as the chunks it replaces. */
function sameRun(a, b) {
  return a.turnId === b.turnId && a.update.sessionUpdate === b.update.sessionUpdate && a.update.messageId === b.update.messageId;
}

/**
 * Append-only, one JSON record per line, for harnesses whose history Sage keeps itself (ACP agents
 * without session/load). A crash can leave a half-written last line; readAsync() skips it.
 *
 * Appends go through the transcript writer (transcriptWriter.cjs): batched and asynchronous, so a streaming
 * agent never blocks the main process per record. Reads include records not on disk yet; flush() writes a
 * chat's records now, and drain() writes every chat's before the app quits.
 */
class ItemsLog {
  /**
   * @param {string} dir
   * @param {{ writer?: InstanceType<typeof import('./transcriptWriter.cjs').TranscriptWriter>, coalesceMs?: number }} [o]
   */
  constructor(dir, { writer = new TranscriptWriter(), coalesceMs = COALESCE_MS } = {}) {
    this.dir = dir;
    this.writer = writer;
    this.coalesceMs = coalesceMs;
    /** @type {Map<string, any>} a chat's text chunk still growing, not yet queued to the writer */
    this.chunks = new Map();
    this.chunkTimer = null;
  }
  file(id) {
    return path.join(this.dir, encodeURIComponent(id) + '.items.jsonl');
  }
  /**
   * Append a streamed update. Adjacent text chunks of one message merge into one record (every token would otherwise be a
   * line to write, read and parse); the merged record is queued after `coalesceMs`, and before any other record of the chat,
   * a flush, a read, a drain or a removal, so the order and what a crash leaves are the same as the unmerged lines'.
   */
  appendUpdate(id, rec) {
    if (typeof id !== 'string' || !id) return;
    if (!isTextChunk(rec)) return this.append(id, rec);
    const held = this.chunks.get(id);
    if (held && sameRun(held, rec)) {
      held.update = { ...held.update, content: { ...held.update.content, text: held.update.content.text + rec.update.content.text } };
      return;
    }
    this.queueHeld(id);
    this.chunks.set(id, { ...rec });
    if (!this.chunkTimer) {
      this.chunkTimer = setTimeout(() => {
        this.chunkTimer = null;
        this.queueHeld();
      }, this.coalesceMs);
      // a held chunk never keeps the process alive; quitting drains first (drain())
      this.chunkTimer.unref();
    }
  }
  /** Queue the held chunk of `id` (every chat's when none is named) to the writer. */
  queueHeld(id) {
    for (const key of id === undefined ? [...this.chunks.keys()] : [id]) {
      const rec = this.chunks.get(key);
      if (!rec) continue;
      this.chunks.delete(key);
      this.writeRecords(key, [rec]);
    }
  }
  append(id, ...records) {
    if (typeof id !== 'string' || !id || !records.length) return;
    this.queueHeld(id);
    this.writeRecords(id, records);
  }
  writeRecords(id, records) {
    this.writer.append(
      this.file(id),
      records.map((r) => JSON.stringify(r) + '\n'),
      { mode: 0o600, what: 'write a chat transcript', chat: id },
    );
  }
  /** Write the chat's queued records now; resolves once they are on disk (or their write failed and was reported). */
  flush(id) {
    this.queueHeld(id);
    return this.writer.flush(this.file(id));
  }
  /** How many bytes of the chat's transcript are on disk. */
  size(id) {
    return fs.promises.stat(this.file(id)).then(
      (stat) => stat.size,
      (error) => {
        noteIgnored("measure a chat's transcript", error, ['ENOENT']);
        return 0;
      },
    );
  }
  /** Write every queued record and wait for it; later records are written as they come (the app is quitting). */
  drain() {
    this.queueHeld();
    return this.writer.drain();
  }
  /** Run `fn(id, error)` when a chat's transcript cannot be written; returns a function that stops it. */
  onWriteError(fn) {
    return this.writer.onError((file, error) => {
      if (path.resolve(path.dirname(file)) !== path.resolve(this.dir) || !file.endsWith('.items.jsonl')) return;
      let id;
      try {
        id = decodeURIComponent(path.basename(file).slice(0, -'.items.jsonl'.length));
      } catch (e) {
        noteIgnored("name a chat whose transcript can't be written", e);
        return;
      }
      fn(id, error);
    });
  }
  /** The transcript's text, with records not on disk yet after it, read without blocking the main process. */
  readText(id) {
    this.queueHeld(id);
    return this.writer.readText(this.file(id));
  }
  /**
   * The transcript's records, read without blocking the main process: what a window asks for (a chat's history, the list,
   * search) reads this. There is deliberately no synchronous form, so no caller can block on a whole transcript.
   */
  async readAsync(id) {
    let text = '';
    try {
      text = await this.readText(id);
    } catch (error) {
      // no transcript yet (ENOENT): no items
      noteIgnored("read a chat's transcript", error, ['ENOENT']);
      return [];
    }
    return recordsOf(text);
  }
  /** A transcript's text (readText) as its records, as readAsync() parses it. @param {string} text */
  parse(text) {
    return recordsOf(text);
  }
  /**
   * What a list or a search wants of a transcript, sifted off the main process: the records of `kinds`, and whether `needle`
   * (lowercase) is anywhere in it. Throws as readText does.
   * @param {string} id @param {{ kinds?: string[], needle?: string }} o
   */
  async scan(id, o) {
    this.queueHeld(id);
    const scanned = await this.writer.scan(this.file(id), o);
    noteTorn(scanned.torn);
    return scanned;
  }
  /** The records of only `kinds` (a list entry, a title); none when there is no transcript yet. @param {string} id @param {string[]} kinds */
  async readKindsAsync(id, kinds) {
    try {
      return (await this.scan(id, { kinds })).records;
    } catch (error) {
      // no transcript yet (ENOENT): no items
      noteIgnored("read a chat's transcript", error, ['ENOENT']);
      return [];
    }
  }
  /** The recordings these transcripts name, as file names: a read that fails rejects, and no transcript yet names none. @param {string[]} ids */
  audioRefs(ids) {
    for (const id of ids) this.queueHeld(id);
    return this.writer.audioRefs(ids.map((id) => this.file(id)));
  }
  has(id) {
    if (this.chunks.has(id)) return true;
    return this.writer.has(this.file(id));
  }
  /** Ids with a transcript, newest first by file time. */
  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (error) {
      // no chats folder yet (ENOENT): the list is empty
      noteIgnored('list the chat transcripts', error, ['ENOENT']);
    }
    return this.newestFirst(
      names.flatMap((f) => this.entryOf(f, () => fs.statSync(path.join(this.dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0)),
    );
  }
  /** list() without blocking the main process. */
  async listAsync() {
    let names = [];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch (error) {
      // no chats folder yet (ENOENT): the list is empty
      noteIgnored('list the chat transcripts', error, ['ENOENT']);
    }
    const entries = names.flatMap((f) =>
      this.entryOf(f, () =>
        fs.promises.stat(path.join(this.dir, f)).then(
          (st) => st.mtimeMs,
          // removed since it was listed
          () => 0,
        ),
      ),
    );
    return this.newestFirst(await Promise.all(entries.map(async ({ id, mtime }) => ({ id, mtime: await mtime }))));
  }
  /**
   * A transcript file's chat id with its time, from `mtime()`; none for another file or a damaged name.
   * @template T
   * @param {string} f
   * @param {() => T} mtime
   * @returns {{ id: string, mtime: T }[]}
   */
  entryOf(f, mtime) {
    if (!f.endsWith('.items.jsonl')) return [];
    try {
      const id = decodeURIComponent(f.slice(0, -'.items.jsonl'.length));
      if (!id || path.basename(this.file(id)) !== f) throw new Error('Transcript id does not match its file');
      return [{ id, mtime: mtime() }];
    } catch (error) {
      // One damaged filename or unreadable entry must not hide the other transcripts.
      noteIgnored('list a chat transcript file', error);
      return [];
    }
  }
  /** @param {{ id: string, mtime: number }[]} entries */
  newestFirst(entries) {
    return entries.sort((a, b) => b.mtime - a.mtime);
  }
  /** Delete the transcript for good: queued records go with it, and records that arrive later are not written. */
  remove(id) {
    this.chunks.delete(id);
    this.writer.remove(this.file(id));
  }
}

module.exports = { ItemsLog };
