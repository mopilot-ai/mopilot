// Claude Code transcripts on disk and the sessions other apps run: finding, listing, searching and following them, and their edit checkpoints.
const { clock } = require('../../platform/ports/clock.cjs');
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { projectsRoot } = require('../../platform/claudeHome.cjs');
const { coreCall } = require('../../platform/core.cjs');
const { tipOf, ownTipOf } = require('./transcriptStep.cjs');
const { parseJsonRecord, jsonStringField, isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { goalStatusAttachment } = require('../../../shared/claudeGoals.mjs');
const { presence, appOf } = require('./presence.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { searchScans, SEARCH_FILES, SEARCH_MS } = require('../../platform/searchScans.cjs');
const { appTurnsWorker } = require('../../platform/claudeTurnsWorker.cjs');
const { readHookRecords, withHookNotices } = require('../../platform/claudeTranscriptNotices.cjs');
const { createTranscriptReader } = require('../../platform/claudeTranscriptRead.cjs');
const { agentItems } = require('../../platform/claudeHistory.cjs');
const { createTurnReads } = require('./turnReads.cjs');
const { createSessionList } = require('./sessionList.cjs');

const { labeled } = require('../../perf/stalls.cjs');

const { readMessages, readTurnPage, readTail, closeQuietly } = createTranscriptReader({ noteIgnored, labeled });

/**
 * Where each session's transcript was last found, by projects folder and session. Finding one lists every project
 * folder, and every chat switch, follow and settings read asks again: a known place is checked with one stat, and a
 * transcript gone from it (moved to another project, deleted) is looked for again. A miss is not kept, so a session
 * that writes its first transcript later is found then.
 */
const located = new Map();
const LOCATED_MAX = 2000;
const locatedKey = (root, sessionId) => `${root}\0${sessionId}`;
function remember(key, file) {
  if (located.size >= LOCATED_MAX) located.clear();
  located.set(key, file);
  return file;
}

/** Where a session's transcript is, in any project folder; null when there is none. */
function transcriptPath(sessionId) {
  const root = projectsRoot();
  const key = locatedKey(root, sessionId);
  const known = located.get(key);
  if (known && fs.existsSync(known)) return known;
  located.delete(key);
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return remember(key, f);
    }
  } catch (error) {
    // no projects folder (ENOENT): no transcript
    noteIgnored('look for a Claude Code transcript', error, ['ENOENT']);
  }
  return null;
}

const present = (f) =>
  fs.promises.access(f).then(
    () => true,
    () => false,
  );
/** transcriptPath without blocking the main process: what a chat switch reads goes through here. */
async function findTranscript(sessionId) {
  const root = projectsRoot();
  const key = locatedKey(root, sessionId);
  const known = located.get(key);
  if (known && (await present(known))) return known;
  located.delete(key);
  let dirs;
  try {
    dirs = await fs.promises.readdir(root);
  } catch (error) {
    noteIgnored('look for a Claude Code transcript', error, ['ENOENT']);
    return null;
  }
  // every folder at once, the first in listing order winning as in transcriptPath
  const files = dirs.map((d) => path.join(root, d, `${sessionId}.jsonl`));
  const at = (await Promise.all(files.map(present))).indexOf(true);
  return at < 0 ? null : remember(key, files[at]);
}

/**
 * Every transcript under the projects folder, by session (the first in listing order, as in transcriptPath): one
 * listing per project folder, all at once, for a search that looks up hundreds of sessions.
 */
async function transcriptIndex() {
  const root = projectsRoot();
  const index = new Map();
  let dirs;
  try {
    dirs = await fs.promises.readdir(root);
  } catch (error) {
    noteIgnored('list the Claude Code transcripts', error, ['ENOENT']);
    return index;
  }
  const lists = await Promise.all(
    dirs.map((d) =>
      fs.promises.readdir(path.join(root, d)).catch((error) => {
        // a file beside the project folders, or one gone meanwhile, holds no transcripts
        noteIgnored('list the Claude Code transcripts', error, ['ENOTDIR', 'ENOENT']);
        return [];
      }),
    ),
  );
  dirs.forEach((d, i) => {
    for (const name of lists[i]) {
      const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
      if (id && !index.has(id)) index.set(id, path.join(root, d, name));
    }
  });
  return index;
}

/** How far into a transcript findSessionCwd looks for a cwd, in chunks of CWD_CHUNK. */
const CWD_SCAN_MAX = 16 * 1024 * 1024;
const CWD_CHUNK = 256 * 1024;
/** Takes a transcript's text chunk by chunk, from its start: the first cwd field, once one is seen (else null). */
function cwdScan() {
  let text = '';
  return (/** @type {string} */ piece) => {
    // a field cut between two chunks is read whole from the last 4 KB kept
    text = text.slice(-4096) + piece;
    return jsonStringField(text, 'cwd');
  };
}

/**
 * The SDK's listSessions takes cwd from the transcript's first 64 KB only, so a session whose first
 * message carries a pasted image comes back without one (and lands outside its project). Scan
 * further for the first cwd field, without blocking the main process.
 * @param {string} sessionId
 * @param {string | null} [known] where its transcript is (null: none), when the caller listed them already
 */
async function findSessionCwd(sessionId, known) {
  const file = known === undefined ? await findTranscript(sessionId) : known;
  if (!file) return undefined;
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const chunk = Buffer.allocUnsafe(CWD_CHUNK);
      const scan = cwdScan();
      for (let pos = 0; pos < CWD_SCAN_MAX; ) {
        const { bytesRead: n } = await handle.read(chunk, 0, chunk.length, pos);
        if (!n) break;
        pos += n;
        const cwd = scan(chunk.toString('utf8', 0, n));
        if (cwd !== null) return cwd;
      }
    } finally {
      await closeQuietly(handle);
    }
  } catch (error) {
    // a transcript gone meanwhile (ENOENT), unreadable, or with a malformed cwd: no cwd known
    noteIgnored("read a Claude Code session's folder", error, ['ENOENT']);
  }
  return undefined;
}

/**
 * Whether a transcript file's text holds `needle` (lowercase, JSON-escaped), read off the main process, at most 8 MB of it.
 * A file gone or unreadable since it was listed holds nothing: the route's error, noted.
 */
async function transcriptHas(file, needle) {
  try {
    return (await coreCall('transcript.contains', undefined, JSON.stringify({ file, needle, limit: 8 * 1024 * 1024 }))) === true;
  } catch (error) {
    noteIgnored('search a Claude Code transcript', error);
    return false;
  }
}

const transcriptTip = (sessionId) => tipOf(transcriptPath(sessionId));
const ownTip = (s) => ownTipOf(transcriptPath(s.sessionId), s.seen);

/** The model and effort a session last ran with, from the newest assistant record in its transcript. */
async function sessionSettings(sessionId) {
  const file = await findTranscript(sessionId);
  if (!file) return null;
  let lines;
  try {
    lines = (await readTail(file, 512 * 1024)).split('\n');
  } catch (error) {
    // a transcript gone meanwhile (ENOENT) or unreadable: no model recorded
    noteIgnored("read a Claude Code session's model", error, ['ENOENT']);
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseJsonRecord(lines[i]);
    if (!parsed.ok) continue;
    const d = parsed.record;
    const message = isJsonRecord(d.message) ? d.message : null;
    const model = message?.model;
    if (d.type === 'assistant' && typeof model === 'string' && model && !/^<.*>$/.test(model))
      return { model, effort: typeof d.effort === 'string' ? d.effort : null };
  }
  return null;
}

/** The transcript's goal_status records (newest last), which the SDK stream never carries; the renderer parses them. */
async function goalStatus(sessionId) {
  const file = await findTranscript(sessionId);
  if (!file) return null;
  try {
    return (await readTail(file, 1024 * 1024))
      .split('\n')
      .filter((line) => {
        const parsed = parseJsonRecord(line);
        return parsed.ok && (parsed.record.type === 'goal_status' || goalStatusAttachment(parsed.record) !== null);
      })
      .join('\n');
  } catch {
    return null;
  }
}

/**
 * Each transcript's checkpoints as last read, by file: switching back to a chat whose transcript has not changed
 * (same size and time) reads nothing. Bounded to the most recently used transcripts.
 */
const checkpointReads = new Map();
const CHECKPOINT_READS_MAX = 24;
/** The rewindable user messages and what each follows, read off the main process. */
async function checkpoints(sessionId) {
  const file = await findTranscript(sessionId);
  if (!file) return {};
  try {
    const { size, mtimeMs } = await fs.promises.stat(file);
    const known = checkpointReads.get(file);
    // taken out and put back last, so the least recently used go first
    checkpointReads.delete(file);
    if (known && known.size === size && known.mtimeMs === mtimeMs) {
      checkpointReads.set(file, known);
      return known.value;
    }
    // no more than the size just read: a cached answer is never newer than its key
    const value = await coreCall('transcript.checkpoints', undefined, JSON.stringify({ file, size }));
    if (checkpointReads.size >= CHECKPOINT_READS_MAX) checkpointReads.delete(checkpointReads.keys().next().value);
    checkpointReads.set(file, { size, mtimeMs, value });
    return value;
  } catch {
    return {};
  }
}

/** @param {import('./state.cjs').ClaudeState} state */
function createTranscripts(state, turnsWorker = appTurnsWorker()) {
  // Sessions run by Claude desktop or the CLI only reach Sage through their transcript file, so the
  // open chat follows it: each write (one per message) refreshes the view.
  const watchers = new Map();
  /** Sessions whose transcript is being looked up to follow it: an unwatch meanwhile cancels the follow. */
  const following = new Set();

  /** A session's transcript as the SDK reads it, with what it drops put back (claudeTranscriptRead.cjs). */
  async function messages(sessionId) {
    const file = await findTranscript(sessionId);
    return readMessages(await state.sdk(), file, sessionId, () => state.resumeAt.get(`claude:${sessionId}`));
  }

  const { turns, windowPage, allTurns, recentTurns, replies } = createTurnReads({ state, turnsWorker, findTranscript, readTurnPage });

  /**
   * What a session's transcript is now: its file, inode, size and time, which an append, a compaction and a rewrite all change, so rows made from
   * one stamp are never served under another (electron/app/panelRowsCache.cjs). Null when there is no transcript or it cannot be read.
   * @param {string} sessionId
   */
  async function stamp(sessionId) {
    const file = await findTranscript(sessionId);
    if (!file) return null;
    try {
      const { ino, size, mtimeMs } = await fs.promises.stat(file);
      return `${file}:${ino}:${size}:${mtimeMs}`;
    } catch (error) {
      noteIgnored('read the state of a Claude Code transcript', error, ['ENOENT']);
      return null;
    }
  }

  /**
   * A sub-agent's own transcript (its sidecar file), read by the agent page. The chat's folder is tried first;
   * a session that moved (a worktree) is found by searching every project.
   */
  async function subagentMessages(sessionId, agentId, dir) {
    const { getSubagentMessages } = await state.sdk();
    if (!/^a[0-9a-f]{16}$/.test(String(agentId))) return [];
    const found = dir ? await getSubagentMessages(sessionId, agentId, { dir }) : [];
    const selected = found.length ? found : await getSubagentMessages(sessionId, agentId);
    const parent = await findTranscript(sessionId);
    const file = parent && path.join(path.dirname(parent), sessionId, 'subagents', `agent-${agentId}.jsonl`);
    return withHookNotices(selected, await readHookRecords(file && (await present(file)) ? file : null));
  }

  /**
   * A sub-agent's stored transcript as its agent page's items, as JSON the window parses (`{ items, model, unread }`, none when it
   * left no transcript here).
   * @param {string} sessionId @param {string} agentId @param {{ chatId: string, cwd: string, settled: boolean, dir?: string | null }} o
   */
  async function subagentItems(sessionId, agentId, { chatId, cwd, settled, dir }) {
    const messages = await subagentMessages(sessionId, agentId, dir);
    return messages.length ? agentItems(messages, chatId, cwd, settled) : null;
  }

  /** Native session metadata, shared by the desktop IPC and windowless readers such as Chrome's side panel. */
  async function info(sessionId) {
    return (await state.sdk()).getSessionInfo(sessionId);
  }

  /** A page of the sessions, newest first, cut from one listing that every page and caller shares (sessionList.cjs). */
  const listSessions = createSessionList(
    () => state.sdk(),
    async (list) => {
      const missing = list.filter((s) => !s.cwd);
      // every project folder listed once for all of them, not once per session
      const index = missing.length ? await transcriptIndex() : null;
      await Promise.all(missing.map(async (s) => (s.cwd = await findSessionCwd(s.sessionId, index?.get(s.sessionId) ?? null))));
    },
  );

  /** Each caller's newest search (a window's palette): a newer one replaces the scan still running for it. */
  const searches = searchScans();

  /**
   * Sessions whose title, first prompt or transcript holds `term`, newest first. The transcript scan
   * is bounded (files and time) so a long history never stalls the palette, and reads each transcript
   * without blocking the main process. A search replaced by its caller's next one stops and finds nothing:
   * the caller has dropped its answer already.
   * @param {string | null} [caller] the search box asking (main's IPC names it by window and box)
   */
  function searchSessions(term, limit = 30, caller = null) {
    return searches(caller, async (replaced) => {
      const q = String(term ?? '')
        .trim()
        .toLowerCase();
      if (!q) return [];
      const needle = JSON.stringify(q).slice(1, -1);
      const all = await (await state.sdk()).listSessions({});
      // listed only once some session needs its transcript read
      /** @type {Map<string, string> | null} */
      let index = null;
      const out = [];
      const deadline = clock.now() + SEARCH_MS;
      let scanned = 0;
      for (const s of all) {
        if (out.length >= limit) break;
        const head = `${s.customTitle ?? ''}\n${s.summary ?? ''}\n${s.firstPrompt ?? ''}`.toLowerCase();
        let hit = head.includes(q);
        if (!hit && scanned < SEARCH_FILES && clock.now() < deadline) {
          if (replaced()) return [];
          scanned++;
          const file = (index ??= await transcriptIndex()).get(s.sessionId);
          hit = !!file && (await transcriptHas(file, needle));
        }
        if (!hit) continue;
        if (!s.cwd) s.cwd = await findSessionCwd(s.sessionId, index?.get(s.sessionId));
        out.push(s);
      }
      return out;
    });
  }

  /** Whether the latest transcript messages are known writes of this app, even after its CLI exited. */
  function ownWrites(sessionId) {
    const s = state.sessions.get(`claude:${sessionId}`);
    if (s?.busy || s?.woken || s?.tipTimer) return true;
    const known = s ? s.tip : state.endedTips.get(sessionId);
    return !!known && transcriptTip(sessionId) === known;
  }

  /** Follows a session's transcript; whether it is followed (false: no transcript, or it cannot be watched). */
  async function watch(sessionId) {
    if (watchers.has(sessionId)) return true;
    following.add(sessionId);
    const file = await findTranscript(sessionId);
    // another call followed it while the file was looked for
    if (watchers.has(sessionId)) return true;
    // the chat was let go while the file was looked for
    if (!following.delete(sessionId)) return false;
    if (!file) return false;
    try {
      /** @type {import('node:fs').FSWatcher & { timer?: NodeJS.Timeout }} */
      const w = fs.watch(file, () => {
        if (watchers.get(sessionId) !== w) return;
        clock.clearTimeout(w.timer);
        w.timer = clock.setTimeout(() => {
          // Sage's own writes reach the view through the stream; only pass on what another app wrote
          if (ownWrites(sessionId)) return;
          state.emit({ key: `claude:${sessionId}`, kind: 'transcript' });
        }, 300);
      });
      // a failed watcher (the file went away) is let go, so the session can be followed again
      w.on('error', () => watchers.get(sessionId) === w && unwatch(sessionId));
      watchers.set(sessionId, w);
      // Register before reconciliation; its synchronous probe runs before a later snapshot IPC.
      try {
        state.watchHooks.onWatch?.(`claude:${sessionId}`, file);
      } catch (error) {
        if (watchers.get(sessionId) === w) unwatch(sessionId);
        throw error;
      }
      return watchers.get(sessionId) === w;
    } catch {
      return false;
    }
  }
  function unwatch(sessionId) {
    following.delete(sessionId);
    const w = watchers.get(sessionId);
    clock.clearTimeout(w?.timer);
    w?.close();
    watchers.delete(sessionId);
    state.watchHooks.onUnwatch?.(`claude:${sessionId}`);
  }

  /** Let go of every followed transcript (the app is quitting). */
  function unwatchAll() {
    turnsWorker?.close();
    for (const id of [...watchers.keys()]) unwatch(id);
  }

  return {
    info,
    messages,
    turns,
    windowPage,
    allTurns,
    recentTurns,
    stamp,
    /** the readers of turns a peer takes (electron/session/peerNativeHistory.cjs claudePeerSource) */
    turnReads: { allTurns, recentTurns },
    replies,
    subagentMessages,
    subagentItems,
    listSessions,
    searchSessions,
    watch,
    unwatch,
    unwatchAll,
    ownWrites,
  };
}

module.exports = {
  createTranscripts,
  transcriptPath,
  findTranscript,
  findSessionCwd,
  transcriptHas,
  transcriptTip,
  ownTip,
  sessionSettings,
  goalStatus,
  checkpoints,
  presence,
  appOf,
};
