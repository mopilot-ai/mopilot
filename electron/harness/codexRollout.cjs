// A Codex thread's history read from its rollout file in main, for when the app-server that reads it is down: the
// file found under $CODEX_HOME (sessions/YYYY/MM/DD or archived_sessions, plain or zstd-compressed), its turns paged. The
// core reads the file and holds its turns (core/crates/rollout), so only the page asked for reaches the JS heap.
const { coreCall } = require('../platform/core.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

/** A cursor for the turns before the one at this index, oldest first. */
const CURSOR = /^rollout:(\d+)$/;

/** The day folders a thread's rollout may be in: its UUIDv7 id's time, as a local date, and the day either side. */
function dayDirs(sessions, threadId) {
  const ms = Number.parseInt(threadId.replace(/-/g, '').slice(0, 12), 16);
  if (!Number.isFinite(ms)) return [];
  return [0, -1, 1].map((d) => {
    const t = new Date(ms + d * 86_400_000);
    const pad = (n) => String(n).padStart(2, '0');
    return path.join(sessions, String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate()));
  });
}

/** Files in `dir` and the folders under it whose name is this thread's rollout. */
async function findIn(dir, name, deep) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const file = entries.find((e) => e.isFile() && name(e.name));
  if (file) return path.join(dir, file.name);
  if (!deep) return null;
  // newest folders first: a chat opened lately is most likely recent
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const found = await findIn(path.join(dir, e.name), name, true);
    if (found) return found;
  }
  return null;
}

/** Whether `file` is under `home`. */
function within(home, file) {
  const rel = path.relative(home, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** How long a parse is kept for the next page, and a thread with no file is not looked for again. */
const KEEP_MS = 60_000;

/**
 * A parse the core holds: its id, the folder it ran in and how many turns it has, with the file it came from, the reads
 * paging it now, and whether it has been let go.
 * @typedef {{ id: number, cwd: unknown, count: number, file: string, mtimeMs: number, size: number, reading: number, replaced: boolean }} Held
 */

/**
 * The JSON reply of the core's `route`: a failure rejects, since a file that can't be read isn't an empty one.
 * @param {string} route @param {string} payload
 */
const rolloutCall = (route, payload) => coreCall(route, undefined, payload);

/**
 * @param {{ codexHome: (threadId?: string) => string, call?: typeof rolloutCall }} o where Codex keeps a thread's sessions:
 *   the CODEX_HOME of the app-server that runs it (the user's, or MoMo's own for a MoMo chat's thread, #2326), never the
 *   other's
 */
function createCodexRollouts({ codexHome, call = rolloutCall }) {
  /** thread id -> its rollout file, as last found */
  const files = new Map();
  /** threads looked for and not found in the last minute: the whole tree is walked at most once a minute for each */
  const missing = new Set();
  /** lets the last parse go: a long chat's history is hundreds of megabytes, kept only while it is being paged */
  let release = /** @type {NodeJS.Timeout | null} */ (null);
  /** the last file parsed, held by the core while it doesn't change: paging reads it again for each page */
  let parsed = /** @type {Held | null} */ (null);

  const exists = (f) =>
    fs.promises.stat(f).then(
      (s) => s.isFile(),
      () => false,
    );

  /** The thread's rollout file, or null. `hint`: where the app-server last said it is (Codex may have compressed it since). */
  async function locate(threadId, hint) {
    const home = codexHome(threadId);
    const named = (n) => n.startsWith('rollout-') && (n.endsWith(`${threadId}.jsonl`) || n.endsWith(`${threadId}.jsonl.zst`));
    for (const f of [files.get(threadId), hint, hint && `${hint}.zst`]) {
      // only a rollout of this thread inside its own home, never another file a window names
      if (typeof f === 'string' && named(path.basename(f)) && within(home, f) && (await exists(f))) return f;
    }
    const [sessions, archived] = rolloutFolders(home);
    for (const dir of dayDirs(sessions, threadId)) {
      const f = await findIn(dir, named, false);
      if (f) return f;
    }
    return (await findIn(archived, named, false)) ?? (await findIn(sessions, named, true));
  }

  /** Let the core drop what it holds of `held`, once no read is paging it. */
  function closeWhenIdle(/** @type {Held} */ held) {
    if (!held.replaced || held.reading) return;
    call('rollout.close', String(held.id)).catch((error) => noteIgnored('close a Codex rollout', error));
  }

  /** Stop keeping the last parse. */
  function letGo() {
    if (!parsed) return;
    parsed.replaced = true;
    closeWhenIdle(parsed);
    parsed = null;
  }

  /**
   * The file's history, held by the core, with one more read holding it: the caller ends that (`finished`), so that a
   * parse let go meanwhile stays until its page is out. A read error or a bad compressed frame rejects.
   */
  async function read(file) {
    const s = await fs.promises.stat(file);
    const was = parsed;
    if (was && was.file === file && was.mtimeMs === s.mtimeMs && was.size === s.size) {
      was.reading++;
      return was;
    }
    const opened = await call('rollout.open', file);
    /** @type {Held} */
    const held = { ...opened, file, mtimeMs: s.mtimeMs, size: s.size, reading: 1, replaced: false };
    letGo();
    parsed = held;
    if (release) clock.clearTimeout(release);
    release = clock.setTimeout(letGo, KEEP_MS);
    release.unref?.();
    return held;
  }

  function finished(/** @type {Held} */ held) {
    held.reading--;
    closeWhenIdle(held);
  }

  /** The turns from `start` up to `end`, over as many replies as they take: the core ends a reply early when they are large. */
  async function turnsOf(/** @type {Held} */ held, /** @type {number} */ start, /** @type {number} */ end) {
    const turns = [];
    // what `slice` makes of a start that isn't a whole number
    let at = Math.trunc(start) || 0;
    while (at < end) {
      const page = await call('rollout.page', `${held.id} ${at} ${end}`);
      for (const turn of page) turns.push(turn);
      at += page.length;
    }
    return turns;
  }

  /**
   * The thread's turns from its rollout, oldest first: the `limit` latest before `cursor` (all without a limit), the
   * cursor for the page before them, and the folder it ran in. null when there is no rollout for it.
   * @param {string} threadId
   * @param {{ hint?: string | null, cursor?: string | null, limit?: number }} [o]
   */
  async function history(threadId, o = {}) {
    if (typeof threadId !== 'string' || !threadId) return null;
    if (missing.has(threadId) && !o.hint) return null;
    if (!codexHome(threadId)) {
      noteIgnored('read a Codex rollout', new Error("no CODEX_HOME is known for this thread yet, so it isn't read"));
      return null;
    }
    const file = await locate(threadId, o.hint);
    if (!file) {
      if (!missing.has(threadId)) clock.setTimeout(() => missing.delete(threadId), KEEP_MS).unref?.();
      missing.add(threadId);
      return null;
    }
    missing.delete(threadId);
    files.set(threadId, file);
    const held = await read(file);
    try {
      const end = Math.min(held.count, Number(CURSOR.exec(o.cursor ?? '')?.[1] ?? held.count));
      const start = o.limit ? Math.max(0, end - o.limit) : 0;
      return { path: file, cwd: held.cwd, turns: await turnsOf(held, start, end), nextCursor: start > 0 ? `rollout:${start}` : null };
    } finally {
      finished(held);
    }
  }

  /**
   * What the thread's saved history is now: its rollout file, inode, size and time, which the app-server's appends (a turn, a compaction, a
   * rollback) all change, so rows made from one stamp are never served under another (electron/app/panelRowsCache.cjs). Null when there is
   * no rollout for the thread or it cannot be read.
   * @param {string} threadId
   */
  async function stamp(threadId) {
    if (typeof threadId !== 'string' || !threadId || !codexHome(threadId)) return null;
    const file = await locate(threadId);
    if (!file) return null;
    try {
      const { ino, size, mtimeMs } = await fs.promises.stat(file);
      return `${file}:${ino}:${size}:${mtimeMs}`;
    } catch (error) {
      noteIgnored('read the state of a Codex rollout', error, ['ENOENT']);
      return null;
    }
  }

  return { history, locate, stamp };
}

/**
 * The folders a CODEX_HOME keeps its threads' rollouts in: sessions/YYYY/MM/DD, and archived_sessions once a thread is archived.
 * @param {string} home @returns {[sessions: string, archived: string]}
 */
const rolloutFolders = (home) => [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];

/** The user's CODEX_HOME, the one the main app-server runs with. */
function userCodexHome() {
  const env = require('../platform/env.cjs');
  const os = require('node:os');
  return env.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** A thread's own home when it is not the user's (MoMo's), set once the adapter exists (app/codexServer.cjs). */
let ownHome = /** @type {((threadId: string) => string | null) | null} */ (null);
/** @param {((threadId: string) => string | null) | null} fn */
function setThreadHomes(fn) {
  ownHome = fn;
}
/**
 * The CODEX_HOME the app-server holding this thread runs with: every Codex path asks this, none assumes ~/.codex. Fails
 * closed (#2139): before the lookup is wired (setThreadHomes) whose thread this is can't be told, so there is no home, and
 * nothing is read: a MoMo chat's thread is never read from the user's home on a guess.
 */
const homeOfThread = (threadId) => {
  if (!ownHome) return null;
  return (threadId && ownHome(threadId)) || userCodexHome();
};

/** The one reader main uses (its parsed-file cache is shared), on each thread's own CODEX_HOME. */
let shared = /** @type {ReturnType<typeof createCodexRollouts> | null} */ (null);
function codexRollouts() {
  shared ??= createCodexRollouts({ codexHome: homeOfThread });
  return shared;
}

module.exports = { createCodexRollouts, codexRollouts, setThreadHomes, homeOfThread, userCodexHome, rolloutFolders };
