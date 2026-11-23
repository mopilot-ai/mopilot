// Reading a Claude Code session's turns from its transcript file: the SDK's messages plus what its reader drops, handed to the
// core, which replays them and holds the turns. Runs on a worker thread (electron/platform/claudeTurnsWorker.cjs) so a long
// chat is not parsed on the main thread, and in-process when no worker is wired (tests, a worker that failed). Both paths run
// this one code. What comes back is a read's id; main cuts its pages, in one step of its own (`historyPage`).
const fs = require('node:fs');
const fsp = fs.promises;
const { core, requiredCore } = require('./core.cjs');
const { openHistory, releaseHistory, allTurns } = require('./claudeHistory.cjs');
const { proseTurns } = require('../../shared/assistantReplies.mjs');
const { endTurnLines, endTurnUuidsOf, withEndTurns } = require('./claudeEndTurnLines.cjs');
const { readHookRecords, hookRecordsOf, withHookNotices } = require('./claudeTranscriptNotices.cjs');
const { parseJsonRecord } = require('../../shared/jsonRecord.mjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');
const { compactedHistory } = require('./claudeCompactedHistory.cjs');

/**
 * Whether lines of a transcript's end hold a background task's notification whose launching call (the tool use it names) lies before
 * them. The core reads a notification against the call that launched the task, and without it names the task by guess (a shell
 * task for an agent, a task that finished for one that was stopped): such an end is not read as the whole read would read it.
 * @param {any[]} entries
 */
function launchesLost(entries) {
  const launched = new Set();
  const named = [];
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (entry?.type === 'assistant' && Array.isArray(content))
      for (const block of content) if (block?.type === 'tool_use' && typeof block.id === 'string') launched.add(block.id);
    if (entry?.type === 'system' && entry.subtype === 'task_notification' && typeof entry.tool_use_id === 'string')
      named.push(entry.tool_use_id);
    if (entry?.type !== 'user') continue;
    const text =
      typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : '')).join('') : '';
    if (text.includes('<task-notification'))
      for (const found of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) named.push(found[1]);
  }
  return named.some((id) => !launched.has(id));
}

/**
 * Whether lines of a transcript's end hold a compaction (its boundary, or the summary after it): the SDK follows a session back to
 * the last one, and a whole read puts the messages it folded away before them, which an end read cannot.
 * @param {any[]} entries
 */
const compactionIn = (entries) =>
  entries.some((entry) => entry?.isCompactSummary === true || (entry?.type === 'system' && entry.subtype === 'compact_boundary'));

/**
 * A session store of lines already read, for the SDK to read a session from: it holds them and takes no writes (the SDK appends only
 * when it runs a session, which a read does not).
 * @param {any[]} entries
 */
const entriesStore = (entries) => ({ append: async () => undefined, load: async () => entries });

/** A line of a transcript's end longer than this has its tool results clipped to `RESULT_CLIP` characters each: a read of the end wants the rows, not megabytes of output. */
const CLIP_LINE = 256 * 1024;
const RESULT_CLIP = 32 * 1024;

/** `value` with every string longer than the clip cut and marked (objects and arrays are walked, in place). */
function clipStrings(value) {
  if (typeof value === 'string')
    return value.length > RESULT_CLIP
      ? `${prefixUnits(value, RESULT_CLIP)}\n… ${value.length - RESULT_CLIP} more characters not read`
      : value;
  if (Array.isArray(value)) return value.map(clipStrings);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = clipStrings(value[key]);
  }
  return value;
}

/** The tool results of a long line's record clipped, in whatever shape the CLI keeps them (the message's `tool_result` blocks, and `toolUseResult`). */
function clipResults(record) {
  const blocks = record?.message?.content;
  if (Array.isArray(blocks)) for (const block of blocks) if (block?.type === 'tool_result') block.content = clipStrings(block.content);
  if (record && 'toolUseResult' in record) record.toolUseResult = clipStrings(record.toolUseResult);
  return record;
}

/** How far from a transcript's end its last line copied by a fork is looked for. */
const FORK_LEAF_TAIL = 256 * 1024;

/** What identifies a transcript's bytes: a cached read is good while all of it holds. */
const fingerprint = (st) => `${st.ino}:${st.size}:${st.mtimeMs}`;

/** Most transcripts and bytes the reads kept across calls may hold, as Claude desktop's weighted LRU does. */
const CACHE_MAX_ENTRIES = 8;
const CACHE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Reads kept by session, newest use last: switching back to a chat whose file did not change (or paging back through it)
 * parses nothing. Weighted by the file's size, which what the core holds of it follows closely. A read that leaves is let go
 * of (`release`); a page asked of one that just left is read again.
 * @param {number} [maxEntries] @param {number} [maxBytes] @param {(id: number) => void} [release]
 */
function createReadCache(maxEntries = CACHE_MAX_ENTRIES, maxBytes = CACHE_MAX_BYTES, release = releaseHistory) {
  /** @type {Map<string, { key: string, bytes: number, read: number }>} */
  const entries = new Map();
  let total = 0;
  return {
    get(id, key) {
      const hit = entries.get(id);
      if (!hit || hit.key !== key) return null;
      entries.delete(id);
      entries.set(id, hit);
      return hit.read;
    },
    set(id, key, bytes, read) {
      const old = entries.get(id);
      if (old) {
        total -= old.bytes;
        release(old.read);
      }
      entries.delete(id);
      entries.set(id, { key, bytes, read });
      total += bytes;
      // the least recently used go first, but never the entry just stored
      for (const [k, v] of entries) {
        if (entries.size <= 1 || (entries.size <= maxEntries && total <= maxBytes)) break;
        entries.delete(k);
        total -= v.bytes;
        release(v.read);
      }
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * The readers of one transcript, reporting the failures they ignore on purpose through `noteIgnored` (main passes
 * electron/ignored.cjs, the worker thread its own console reporter).
 * `labeled(name, fn)` times a synchronous step for main's stall logger (electron/perf/stalls.cjs); the worker runs it plain.
 * `threadCore` is this thread's own load of the Rust core (the worker loads its own).
 * @param {{ noteIgnored: (what: string, error: unknown, expected?: string[]) => void, labeled?: <T>(name: string, fn: () => T) => T, threadCore?: () => any }} o
 */
function createTranscriptReader({ noteIgnored, labeled = (_name, fn) => fn(), threadCore = core }) {
  /** Closes a read-only file handle on every path, so a failed read does not leak it; a failed close loses nothing, so it is recorded rather than thrown. */
  async function closeQuietly(handle) {
    try {
      await handle.close();
    } catch (error) {
      noteIgnored('close a Claude Code transcript', error);
    }
  }

  /** The last `max` bytes of a file as text, read without blocking the main process. */
  async function readTail(file, max) {
    const handle = await fsp.open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      const len = Math.min(size, max);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await handle.read(buf, 0, len, size - len);
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      await closeQuietly(handle);
    }
  }

  /**
   * The uuid of the last message a fork copied (a line with `forkedFrom`), or null. The SDK's forkSession stamps that copy
   * with the time of the fork and its reader drops `forkedFrom`, so the window could not tell (#1941). A fork's copies
   * never change, so a session's answer is kept; one past FORK_LEAF_TAIL from the end is not found.
   * @type {Map<string, string | null>}
   */
  const forkLeaves = new Map();
  async function forkLeafOf(sessionId, file) {
    if (forkLeaves.has(sessionId)) return forkLeaves.get(sessionId) ?? null;
    const tail = file
      ? await readTail(file, FORK_LEAF_TAIL).catch((error) => (noteIgnored("read a Claude Code transcript's end", error), ''))
      : '';
    const lines = tail.split('\n');
    let leaf = null;
    for (let i = lines.length - 1; i >= 0 && !leaf; i--)
      if (lines[i].includes('"forkedFrom"'))
        try {
          leaf = JSON.parse(lines[i]).uuid ?? null;
        } catch (error) {
          // a line cut by the tail's start, or one the CLI is still writing: the next one up is read
          noteIgnored("read a line of a Claude Code fork's transcript", error);
        }
    forkLeaves.set(sessionId, leaf);
    return leaf;
  }

  /**
   * A session's transcript as the window reads it: the SDK's messages, what a compaction folded away put back before
   * them, hook notices and error types restored, the fork's last copy and end-turn tool results marked again, and the
   * conversation cut at an edited message not yet sent again (`resumeAt`).
   * @param {{ getSessionMessages: Function }} sdk
   * @param {string | null} file where the transcript is
   * @param {string} sessionId
   * @param {string | undefined | (() => string | undefined)} resumeAt a function is asked once every read has settled
   */
  async function readMessages(sdk, file, sessionId, resumeAt) {
    const read = await sdk.getSessionMessages(sessionId, { includeSystemMessages: true });
    // what a compaction folded away, which the SDK's reader leaves out, goes back before what it kept
    const folded = await compactedHistory(file, read);
    const sdkMessages = folded.length ? [...folded, ...read] : read;
    const records = await readHookRecords(file);
    const leaf = await forkLeafOf(sessionId, file);
    const endTurns = file ? await endTurnLines(file, noteIgnored) : new Set();
    return assemble(sdkMessages, { records, leaf, endTurns, resumeAt });
  }

  /**
   * What readMessages makes of the SDK's messages once its reads are in: hook notices and error types restored, the conversation
   * cut at an edited message not yet sent again (`resumeAt`), the fork's last copy and end-turn tool results marked again.
   */
  function assemble(sdkMessages, { records, leaf, endTurns, resumeAt }) {
    // an edited message not yet sent again: the conversation goes on from just before it, so what followed
    // (the old reply) stays hidden however the chat is read again (a watcher's refresh, the chat coming back)
    const cutoff = typeof resumeAt === 'function' ? resumeAt() : resumeAt;
    const all = labeled('claude.messages.merge', () => withHookNotices(sdkMessages, records, cutoff));
    const end = cutoff ? all.findIndex((m) => m.uuid === cutoff) : -1;
    const kept = end < 0 ? all : all.slice(0, end + 1);
    // the fork's last copy is marked again, so its turn isn't timed by the fork (core/crates/translate)
    const marked = leaf ? kept.map((m) => (m.uuid === leaf ? { ...m, forkedFrom: true } : m)) : kept;
    // and a tool result that ended its turn (a wrap-up box) keeps its end-turn flag, which the SDK's reader drops
    return labeled('claude.messages.endTurns', () => withEndTurns(marked, endTurns));
  }

  /**
   * The lines of a transcript's last `maxBytes`, parsed: whole lines only (a window that starts inside a line leaves it out), and
   * whether that is the whole file.
   * @param {string} file @param {number} maxBytes
   */
  async function tailEntries(file, maxBytes) {
    const handle = await fsp.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const len = Math.min(size, maxBytes);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await handle.read(buf, 0, len, size - len);
      const text = buf.toString('utf8', 0, bytesRead);
      const whole = len >= size;
      const entries = [];
      for (const line of (whole ? text : text.slice(text.indexOf('\n') + 1)).split('\n')) {
        if (!line) continue;
        // a line the CLI is still writing does not parse, and is left out until it is whole
        const parsed = parseJsonRecord(line);
        if (parsed.ok) entries.push(line.length > CLIP_LINE ? clipResults(parsed.record) : parsed.record);
      }
      return { entries, whole };
    } finally {
      await closeQuietly(handle);
    }
  }

  /**
   * The messages of a transcript's last `bytes`, as readMessages gives them for that end of the file: the SDK reads only those
   * lines (through a session store that holds them), so the cost is the window's, not the file's. `whole` says the messages are
   * the whole conversation: a file that fits the window, or a read that fell back to readMessages (the SDK's store option is
   * alpha, so a failure there is answered with the full read, as is a transcript that cannot be read at its end). `dangling` says the
   * end holds a background task's notification whose launch lies before it (launchesLost): a reader that wants the turns as the whole
   * read has them reads a larger end; `compacted` says the end holds a compaction, before which the whole read has the messages the SDK
   * leaves out.
   * @param {{ getSessionMessages: Function }} sdk
   * @param {string | null} file @param {string} sessionId
   * @param {string | undefined | (() => string | undefined)} resumeAt
   * @param {{ bytes: number }} window
   * @returns {Promise<{ messages: any[], whole: boolean, dangling: boolean, compacted: boolean }>}
   */
  async function readRecentMessages(sdk, file, sessionId, resumeAt, { bytes }) {
    const full = async () => ({
      messages: await readMessages(sdk, file, sessionId, resumeAt),
      whole: true,
      dangling: false,
      compacted: false,
    });
    if (!file) return full();
    let tail;
    try {
      tail = await tailEntries(file, bytes);
    } catch (error) {
      noteIgnored('read the end of a Claude Code transcript', error);
      return full();
    }
    if (tail.whole) return full();
    let read;
    try {
      read = await sdk.getSessionMessages(sessionId, {
        includeSystemMessages: true,
        sessionStore: entriesStore(tail.entries),
      });
    } catch (error) {
      noteIgnored('read the end of a Claude Code transcript through the SDK', error);
      return full();
    }
    // an edited message not yet sent again cuts the conversation where it is: one before the end read leaves what followed it in
    // (the whole read hides it), so the whole read answers
    const cutoff = typeof resumeAt === 'function' ? resumeAt() : resumeAt;
    if (cutoff && !read.some((m) => m.uuid === cutoff)) return full();
    const leaf = await forkLeafOf(sessionId, file);
    const records = hookRecordsOf(tail.entries);
    return {
      messages: assemble(read, { records, leaf, endTurns: endTurnUuidsOf(tail.entries), resumeAt }),
      whole: false,
      dangling: launchesLost(tail.entries),
      compacted: compactionIn(tail.entries),
    };
  }

  /**
   * The core's read of what `messages` hold.
   * @param {any[]} messages @param {string} chatId @param {string} cwd @param {string} sessionId
   */
  const readInCore = (messages, chatId, cwd, sessionId) => {
    // a worker whose own load failed says so, and its asker reads in main, through main's core: there is no JS copy
    try {
      requiredCore(threadCore());
    } catch (error) {
      throw Object.assign(new Error('this thread could not load the Rust core', { cause: error }), { code: 'CORE_UNAVAILABLE' });
    }
    return openHistory(messages, chatId, cwd, { key: sessionId, step: (run) => labeled('claude.buildTurns', run), ignored: noteIgnored });
  };

  /**
   * One request for a chat's turns: a read in the core (from `cache`, when one is given, while the file is as it was), for its
   * asker to cut pages from. `kept` says the cache holds it; an asker lets go of a read that isn't. `uncached` is for a read that
   * must last or that the cache failed: it neither takes a kept read nor pushes one out.
   * @param {{ sdk: { getSessionMessages: Function }, cache?: ReturnType<typeof createReadCache> }} deps
   * @param {{ sessionId: string, file: string | null, resumeAt?: string | (() => string | undefined), chatId: string, cwd: string, replies?: boolean, uncached?: boolean, recent?: { bytes: number } }} req
   *   recent: only the end of the transcript is read (readRecentMessages), never kept; the answer's `whole` says it is the whole chat, and `dangling` that a background task's launch lies before it, `compacted` that it holds a compaction
   * @returns {Promise<{ read: number, kept: boolean, whole?: boolean, dangling?: boolean, compacted?: boolean } | any[]>}
   */
  async function readTurnPage({ sdk, cache: kept }, req) {
    const { sessionId, file, resumeAt, chatId, cwd } = req;
    const cache = req.uncached ? null : kept;
    // a reader of prose only (every turn stays, so a switched chat's segments still slice): its read is never kept, so a long chat's turns do not push the open chat's out of the cache
    if (req.replies) {
      const read = await readInCore(await readMessages(sdk, file, sessionId, resumeAt), sessionId, cwd, sessionId);
      try {
        return proseTurns(await allTurns(read));
      } finally {
        releaseHistory(read);
      }
    }
    if (req.recent) {
      const { messages, whole, dangling, compacted } = await readRecentMessages(sdk, file, sessionId, resumeAt, req.recent);
      return { read: await readInCore(messages, chatId, cwd, sessionId), kept: false, whole, dangling, compacted };
    }
    /** @type {import('node:fs').Stats | null} */
    let st = null;
    if (file && cache)
      try {
        st = await fsp.stat(file);
      } catch (error) {
        noteIgnored('stat a Claude Code transcript', error, ['ENOENT']);
      }
    // the key is taken before the read: a file that grows meanwhile only makes the next call read again
    const key = st && typeof resumeAt !== 'function' ? `${chatId}|${cwd}|${fingerprint(st)}|${resumeAt ?? ''}` : null;
    const hit = key && cache ? cache.get(sessionId, key) : null;
    if (hit) return { read: hit, kept: true };
    const read = await readInCore(await readMessages(sdk, file, sessionId, resumeAt), chatId, cwd, sessionId);
    if (!key || !st || !cache) return { read, kept: false };
    cache.set(sessionId, key, st.size, read);
    return { read, kept: true };
  }

  return { readMessages, readRecentMessages, readTurnPage, readTail, closeQuietly, forkLeafOf };
}

module.exports = {
  createTranscriptReader,
  createReadCache,
  launchesLost,
  compactionIn,
  entriesStore,
  FORK_LEAF_TAIL,
  CACHE_MAX_ENTRIES,
  CACHE_MAX_BYTES,
};
