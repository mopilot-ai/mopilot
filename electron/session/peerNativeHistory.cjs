// Reading a chat segment's native history as turns for peer messaging and @ references, across Claude Code, ACP and Codex.

const { turnFromServer } = require('../../shared/codexTurns.mjs');
const { codexRefusalNote } = require('../../shared/chatSignals.mjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { codexRollouts } = require('../harness/codexRollout.cjs');
const { readChatTurns } = require('../harness/items/acpTranslator.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * A Claude read's text and reasoning items numbered by their own message: `<message id>:t0`, `:t1`, …, `:r0`. The core numbers them
 * by how many its read has seen (`<message id>:t125` in a whole read, `:t1` in the end of one), so the same message has another id in a
 * read that starts elsewhere, and a phone that names a row to page before it would not find it again. Every message's blocks lie
 * together, and a read of the end leaves out whole turns only, so the numbers here do not depend on where a read began.
 * @param {any[]} turns
 */
function withOwnTextIds(turns) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return turns.map((turn) => ({
    ...turn,
    items: (turn.items ?? []).map((/** @type {any} */ item) => {
      // Claude cold replay keeps the SDK user UUID as id while clientId is null. Normalize at this adapter boundary.
      if (
        item?.type === 'userMessage' &&
        item.clientId == null &&
        typeof item.id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id)
      )
        return { ...item, clientId: item.id.toLowerCase() };
      const named = typeof item?.id === 'string' ? /^(.+):([tr])\d+$/.exec(item.id) : null;
      if (!named) return item;
      const key = `${named[1]}:${named[2]}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return { ...item, id: `${key}${n}` };
    }),
  }));
}

/** How much of a Claude transcript's end is read at first, and how far it grows when that holds too few rows: each a few times the last. */
const RECENT_WINDOWS = [1, 4, 16, 64].map((mb) => mb * 1024 * 1024);

/** A window this large that lies wholly inside one turn means the last turn alone is that large: its end is the read, not the whole history. */
const HUGE_TURN_WINDOW = 16 * 1024 * 1024;

/** The largest window read again for the sake of a background task's launch: a launch before it is read by guess. */
const DANGLING_LIMIT = 16 * 1024 * 1024;

/** A Codex turn read back, with the note a policy refusal leaves in the chat (the app-server says it on the turn's error, not as an item). */
function codexTurn(/** @type {any} */ t) {
  const turn = turnFromServer(t);
  const note = codexRefusalNote(turn);
  return note ? { ...turn, items: [...turn.items, note] } : turn;
}

/**
 * Shared read-only native boundary for both @ references and messaging tools.
 * @param {{ claudeTurns: (id: string, cwd: string, o: { open: boolean }) => Promise<any[]>, claudeRecent?: (id: string, cwd: string, o: { open: boolean, bytes: number }) => Promise<{ turns: any[], whole: boolean, dangling?: boolean, compacted?: boolean }>, claudeStamp?: (id: string) => Promise<string | null>, claudeReplies?: (id: string, cwd: string) => Promise<any[]>, acpTurns: (key: string, threadId: string, o: object) => Promise<any>, codexTurns: (id: string, options: object) => Promise<any>, projectOf?: (seg: any) => Promise<string | null>, codexRollout?: (id: string) => Promise<{ turns: any[] } | null>, codexStamp?: (id: string) => Promise<string | null> }} o
 *   projectOf: the segment's project folder, read without blocking the main process; codexRollout: a Codex thread's
 *   turns from its rollout file, for while the app-server is down (electron/harness/codexRollout.cjs by default)
 */
function createPeerNativeReader({
  claudeTurns,
  claudeRecent,
  claudeStamp,
  claudeReplies,
  acpTurns,
  codexTurns,
  projectOf = async (_seg) => null,
  codexRollout = (id) => codexRollouts().history(id),
  codexStamp = (id) => codexRollouts().stamp(id),
}) {
  /**
   * Each family's reader of a segment's native history as turns.
   * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (seg: any, signal?: AbortSignal, options?: { assistantOnly?: boolean, open?: boolean }) => Promise<{ turns: any[], truncated: boolean }>>}
   */
  const READ = {
    claude: async (seg, _signal, { assistantOnly = false, open = false } = {}) => {
      // prose only: read in the worker, so a huge transcript is never parsed into the main process
      if (assistantOnly && claudeReplies)
        return { turns: await claudeReplies(seg.nativeId, (await projectOf(seg)) ?? ''), truncated: false };
      // a turn main runs now is open: the transcript alone replays a call with no result as finished
      return { turns: withOwnTextIds(await claudeTurns(seg.nativeId, (await projectOf(seg)) ?? '', { open })), truncated: false };
    },
    acp: async (seg, _signal, { open = false } = {}) => {
      // the transcript names its folder, as a rule; a turn main runs now is open: a transcript read cannot tell it from one
      // cut off, and would end its calls as failed
      const read = await acpTurns(`${seg.kind}:${seg.nativeId}`, seg.nativeId, { find: true, otherwise: () => projectOf(seg), live: open });
      return { turns: read.turns, truncated: false };
    },
    codex: async (seg, signal) => {
      let turns = [];
      let cursor = null;
      const seen = new Set();
      try {
        for (let i = 0; i < 40; i++) {
          if (signal?.aborted) throw new Error('aborted');
          const page = await codexTurns(seg.nativeId, { limit: 50, cursor, itemsView: 'full' });
          turns = [...[...(page.data ?? [])].reverse().map(codexTurn), ...turns];
          cursor = page.nextCursor;
          if (!cursor) return { turns, truncated: false };
          if (seen.has(cursor)) break;
          seen.add(cursor);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // the app-server is down: the thread's rollout file has the same turns
        const disk = await codexRollout(seg.nativeId).catch((e) => (noteIgnored("read a Codex thread's rollout file", e), null));
        if (!disk) throw error;
        return { turns: disk.turns.map(codexTurn), truncated: false };
      }
      return { turns, truncated: true };
    },
  };
  /**
   * Each family's reader of the recent end of a segment's history, for a reader that wants only the last rows (a phone opening a
   * chat): `enough(turns)` says whether the turns in hand hold them, and the read goes no further back than that. A reader with no
   * way to read only the end (ACP, a Claude source without one) reads the whole history, as READ does.
   * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (seg: any, signal: AbortSignal | undefined, options: { open?: boolean, enough: (turns: any[]) => boolean }) => Promise<{ turns: any[], truncated: boolean }>>}
   */
  const READ_RECENT = {
    claude: async (seg, signal, { open = false, enough }) => {
      if (!claudeRecent) return READ.claude(seg, signal, { open });
      const project = (await projectOf(seg)) ?? '';
      /** @type {{ turns: any[], truncated: boolean } | null} the first window that held enough rows but a notification without its launch */
      let dangled = null;
      for (const bytes of RECENT_WINDOWS) {
        if (signal?.aborted) throw new Error('aborted');
        const read = await claudeRecent(seg.nativeId, project, { open, bytes });
        if (read.whole) return { turns: withOwnTextIds(read.turns), truncated: false };
        // a window with one turn in it, wholly inside it, and large (a turn of a few MB is still found by a larger window): the last turn alone is huge (tool output), and a larger window
        // would only hold more of it. Its last rows are the read (its start is not, as in any window), never the whole history.
        if (read.turns.length === 1 && bytes >= HUGE_TURN_WINDOW) return { turns: withOwnTextIds(read.turns), truncated: true };
        // a window that starts inside a turn has lost that turn's start: the turn is left out
        const complete = withOwnTextIds(read.turns.slice(1));
        const held = complete.length > 0 && enough(complete);
        // one that holds a background task's notification without the launch of that task reads it by guess: a larger window is read
        // instead, as far as larger is cheap; a launch further back than that is not worth reading the history for
        if (held && !read.dangling) return { turns: complete, truncated: true };
        if (held) dangled ??= { turns: complete, truncated: true };
        if (dangled && bytes >= DANGLING_LIMIT) return dangled;
        // rows that are not there, in a window that holds a compaction, are in what the compaction folded away: only the whole read has them
        if (!held && read.compacted) break;
      }
      // no window held enough (a chat of a few huge turns): the whole history, numbered as a window's is
      const all = await READ.claude(seg, signal, { open });
      return { ...all, turns: withOwnTextIds(all.turns) };
    },
    acp: (seg, signal, { open = false }) => READ.acp(seg, signal, { open }),
    codex: async (seg, signal, { enough }) => {
      try {
        let turns = [];
        let cursor = null;
        const seen = new Set();
        // the newest page first, and older ones only until the turns in hand are enough
        for (let i = 0; i < 40; i++) {
          if (signal?.aborted) throw new Error('aborted');
          const page = await codexTurns(seg.nativeId, { limit: 50, cursor, itemsView: 'full' });
          turns = [...[...(page.data ?? [])].reverse().map(codexTurn), ...turns];
          cursor = page.nextCursor;
          if (!cursor) return { turns, truncated: false };
          if (enough(turns)) return { turns, truncated: true };
          if (seen.has(cursor)) break;
          seen.add(cursor);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // the app-server is down, or the pages did not end: READ.codex has the rollout file for the first, and its own limit for the second
      }
      return READ.codex(seg, signal);
    },
  };
  /**
   * Each family's stamp of a segment's history (null: it cannot say, so what is made from it is not held between reads). A family opts in
   * by naming its history's state: Claude's is its transcript's, Codex's its rollout file's. ACP has none: its history is opened and parsed inside
   * the core, which does not say which file it read, so an ACP chat is read at every page (tested: peerHistoryStamp.test.ts).
   * @type {Record<import('../../shared/harnessKind.mjs').HarnessFamily, (seg: any) => Promise<string | null>>}
   */
  const STAMP = {
    claude: async (seg) => (claudeStamp ? (await claudeStamp(seg.nativeId)) || null : null),
    acp: async () => null,
    codex: async (seg) => (await codexStamp(seg.nativeId)) || null,
  };
  const reader = async (/** @type {any} */ seg, /** @type {AbortSignal | undefined} */ signal, /** @type {any} */ options) => {
    if (signal?.aborted) throw new Error('aborted');
    const family = parseKind(seg.kind)?.family;
    if (!family) throw new Error('unsupported_history_adapter');
    return READ[family](seg, signal, options);
  };
  return Object.assign(reader, {
    /**
     * What a segment's saved history is now, or null when its family cannot say (the rows made from it are then not held between pages):
     * a string that changes whenever the history does, an append, a compaction and a rewrite alike. Claude names its transcript's file and state.
     */
    stamp: async (/** @type {any} */ seg) => {
      const family = parseKind(seg.kind)?.family;
      return family ? STAMP[family](seg) : null;
    },
    /** The reader of the recent end: `reader.recent(seg, signal, { open, enough })`. */
    recent: async (/** @type {any} */ seg, /** @type {AbortSignal | undefined} */ signal, /** @type {any} */ options) => {
      if (signal?.aborted) throw new Error('aborted');
      const family = parseKind(seg.kind)?.family;
      if (!family) throw new Error('unsupported_history_adapter');
      return READ_RECENT[family](seg, signal, options);
    },
  });
}

/**
 * The Claude reads a peer native reader takes, over the harness's transcripts: every turn, and the finished replies alone,
 * both of which the harness reads on its worker.
 * @param {{ stamp?: (id: string) => Promise<string | null>, allTurns: (id: string, o: { chatId: string, cwd: string, open: boolean }) => Promise<any[]>, recentTurns?: (id: string, o: { chatId: string, cwd: string, open: boolean, bytes: number }) => Promise<{ turns: any[], whole: boolean, dangling?: boolean, compacted?: boolean }>, replies: (id: string, opts: { cwd: string }) => Promise<any[]> }} claude
 */
const claudePeerSource = (claude) => ({
  claudeTurns: (id, cwd, { open }) => claude.allTurns(id, { chatId: id, cwd, open }),
  // a harness that cannot read only the end of a transcript has none: its history is read whole
  ...(typeof claude.recentTurns === 'function'
    ? { claudeRecent: (id, cwd, { open, bytes }) => /** @type {any} */ (claude).recentTurns(id, { chatId: id, cwd, open, bytes }) }
    : {}),
  claudeReplies: (id, cwd) => claude.replies(id, { cwd }),
  // a harness that cannot name its transcript's state has none: what is made from its history is not held between reads
  ...(typeof claude.stamp === 'function' ? { claudeStamp: (/** @type {string} */ id) => /** @type {any} */ (claude).stamp(id) } : {}),
});
/** @param {any} acpHost */
const acpPeerSource = (acpHost) => ({
  acpTurns: (/** @type {string} */ key, /** @type {string} */ threadId, /** @type {object} */ o) =>
    readChatTurns(acpHost, key, threadId, o),
});
module.exports = { createPeerNativeReader, claudePeerSource, acpPeerSource, withOwnTextIds };
