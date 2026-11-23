// What each turn of a chat changed in its folder on the Host (#5255): a Git tree of the folder when the turn starts and one when it ends, kept by turn id, and the diff between them for the Changes pane's Last Turn. The Host takes them around every turn of every agent (the stream's turnStart and turnEnd), not an adapter. Every git run of this feature is in this file.
//
// What it leaves alone and what it adds: a snapshot is made in a private index file in a temporary folder (the repository's own index is only read, copied), so status, stash, log, refs and the work tree are untouched (no ref, no stash, no commit, no file of the work tree and no entry of the real index is made or changed). It does add unreachable loose objects to the repository's `.git/objects` (as this Mac's turn snapshots do), bounded as below and pruned by `git gc`; a turn whose objects are gone reads as having no baseline.
// What it grows: every file a snapshot adds is written into the repository's object folder, unreachable, and never removed by the Host (`git prune` is not ours to run in a user's repository; `git gc` removes them after its own expiry). A snapshot adds the files of the folder that changed since git last saw them (the user's edits and the turn's, as git would store them) and at most UNTRACKED_TOTAL_MAX bytes of untracked files, none of them over UNTRACKED_FILE_MAX; a snapshot is taken at a turn's start and end, so a turn adds at most twice that.
// What it keeps: the last KEEP_TURNS turns (the oldest go first), in one file of at most MAX_FILE_BYTES in the Host's data folder, a few hundred bytes a turn: ids of trees, never file contents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareTrees, headOf, snapshotTree } from '../../shared/turnTree.mjs';
import { runGit } from './hostGit.mjs';
import { neutralizeFilters } from './hostRead.mjs';

/** The turns whose trees are kept, and the most the file that keeps them may hold (bytes). */
export const KEEP_TURNS = 50;
export const MAX_FILE_BYTES = 256 * 1024;
/** One snapshot step may take this long; a folder too big for it has no baseline for that turn. */
const SNAPSHOT_MS = 30_000;
/** The patch a read may answer with (as git.diff's bound), and what a snapshot step may print. */
const MAX_PATCH = 4_000_000;
const MAX_STEP = 64_000_000;
/** Snapshots taken at once, over every chat: the rest wait, so a burst of turns never loads the machine. */
const MAX_AT_ONCE = 2;
const SAVE_DELAY_MS = 500;
const TREE = /^[0-9a-f]{40,64}$/;
/** What a snapshot leaves out of the folder's untracked files: any over 5 MB, and what passes 50 MB together (growth bound in the header). */
export const UNTRACKED_FILE_MAX = 5 * 1024 * 1024;
export const UNTRACKED_TOTAL_MAX = 50 * 1024 * 1024;
/** The untracked files left out of a snapshot that are remembered with the turn (the rest are left out all the same, but may show on one side only), and the paths a reply names. */
const SKIPPED_KEPT = 200;
/** The names kept: none longer than this, and all of them together at most this many bytes (they go to git as pathspecs, and come back from a file). */
const SKIPPED_NAME_MAX = 1024;
const SKIPPED_BYTES_MAX = 40_000;
const SKIPPED_NAMED = 10;
/** A temporary snapshot folder this old is one a Host that died left behind. */
const STALE_MS = 60 * 60 * 1000;

/**
 * @typedef {{ id: string, log: number } | null} Head
 * @typedef {{ name: string, sig: string }} Skip an untracked file a snapshot left out, with its size and time when it was (`gone` when it could not be read), so a file the turn changed is told from one that was there all along
 * @typedef {{ chat: string, cwd: string, at: number, start: string | null, startHead: Head, skipped: Skip[], end?: string | null, endHead?: Head, endSkipped?: Skip[] }} Entry a turn's trees; `end` absent while the turn runs (or when the Host stopped under it); `skipped`, `endSkipped`: the untracked files each snapshot left out (at most SKIPPED_KEPT)
 */

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./hostFs.mjs').createHostFs>} o.hostFs
 * @param {string} [o.file] where the turns are kept (none: in memory only)
 * @param {typeof runGit} [o.run] @param {typeof fs.promises} [o.fsp] @param {() => string} [o.tmpdir] @param {() => number} [o.now]
 * @param {number} [o.saveDelayMs] @param {number} [o.keep] @param {number} [o.maxFileBytes] @param {number} [o.maxPatch] @param {{ file: number, total: number }} [o.untracked] the bounds (KEEP_TURNS, MAX_FILE_BYTES, MAX_PATCH, UNTRACKED_*), settable for a test
 */
export function createHostTurnTree({
  hostFs,
  file,
  run = runGit,
  fsp = fs.promises,
  tmpdir = os.tmpdir,
  now = Date.now,
  saveDelayMs = SAVE_DELAY_MS,
  keep = KEEP_TURNS,
  maxFileBytes = MAX_FILE_BYTES,
  maxPatch = MAX_PATCH,
  untracked = { file: UNTRACKED_FILE_MAX, total: UNTRACKED_TOTAL_MAX },
}) {
  /** @type {Map<string, Entry>} turn id -> trees, oldest first */
  const entries = new Map();
  /** @type {Map<string, Promise<unknown>>} turn id -> its start or end snapshot still being taken */
  const working = new Map();
  /** @type {Map<string, string>} chat -> the folder its last message named */
  const folders = new Map();
  let active = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let saving = null;

  /**
   * One git run in `cwd`; fails (throws) when git does, or prints past `max` unless `lenient`, which gives what was printed and notes the cut in `state`.
   * @param {{ cut: boolean }} state @param {boolean} lenient @param {number} max
   * @returns {import('../../shared/turnTree.mjs').Git}
   */
  const gitFor =
    (state, lenient, max) =>
    async (cwd, args, env = {}) => {
      const r = /** @type {any} */ (
        await run(['--no-optional-locks', ...args], { cwd, timeout: SNAPSHOT_MS, maxBytes: max, env: /** @type {any} */ (env) })
      );
      if (r.cut && lenient) {
        state.cut = true;
        return r.stdout;
      }
      if (!r.ok || r.cut) throw new Error('git failed');
      return r.stdout;
    };

  /** Runs `work` when fewer than MAX_AT_ONCE snapshots are being taken. @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  async function slot(work) {
    if (active >= MAX_AT_ONCE) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  /** The names a snapshot's list keeps: at most SKIPPED_KEPT, none past SKIPPED_NAME_MAX characters, together at most SKIPPED_BYTES_MAX bytes. @param {string[]} names */
  function keptNames(names) {
    let bytes = 0;
    /** @type {string[]} */
    const kept = [];
    for (const name of names) {
      bytes += Buffer.byteLength(name);
      if (kept.length >= SKIPPED_KEPT || name.length > SKIPPED_NAME_MAX || bytes > SKIPPED_BYTES_MAX) continue;
      kept.push(name);
    }
    return kept;
  }

  /** @param {string} cwd @param {string[]} names @returns {Promise<Skip[]>} */
  const withSigs = (cwd, names) =>
    Promise.all(
      names.map(async (name) => ({
        name,
        sig: await fsp.lstat(path.join(cwd, name)).then(
          (st) => `${st.size}:${Math.floor(st.mtimeMs)}`,
          () => 'gone',
        ),
      })),
    );

  /** The folder's tree now, where its HEAD is and the untracked files it left out, or null when it cannot be told (not a repository, git failed). @param {string} cwd @param {string[]} [leave] files an earlier snapshot of the turn left out: left out here too @returns {Promise<{ tree: string, head: Head, skipped: Skip[] } | null>} */
  async function capture(cwd, leave = []) {
    try {
      return await slot(async () => {
        const git = gitFor({ cut: false }, false, MAX_STEP);
        // fails for a folder that is no repository: nothing to take
        await git(cwd, ['rev-parse', '--is-inside-work-tree']);
        // the repository's filters must not run when the folder is added to the private index
        // (a failed read of the settings fails the snapshot: no baseline, never a filter that may run)
        const filters = await neutralizeFilters(
          async (args) =>
            /** @type {any} */ (await run(['--no-optional-locks', ...args], { cwd, timeout: SNAPSHOT_MS, maxBytes: MAX_STEP, env: {} })),
        );
        /** @type {string[]} */
        let skippedNames = [];
        const tree = await snapshotTree(
          {
            git,
            env: () => filters,
            fs: fsp,
            tmpdir,
            skipUntracked: { ...untracked, leave, onSkipped: (names) => (skippedNames = keptNames(names)) },
          },
          cwd,
        );
        return { tree, head: await headOf(git, cwd), skipped: await withSigs(cwd, skippedNames) };
      });
    } catch {
      return null;
    }
  }

  function trim() {
    while (entries.size > keep) entries.delete(/** @type {string} */ (entries.keys().next().value));
  }

  function save() {
    if (!file || saving) return;
    saving = setTimeout(() => {
      saving = null;
      try {
        let list = [...entries].map(([turnId, e]) => ({ turnId, ...e }));
        let text = JSON.stringify({ version: 1, turns: list });
        // the file never outgrows its bound, counted in bytes: the oldest turns go
        while (Buffer.byteLength(text) > maxFileBytes && list.length) {
          list = list.slice(1);
          text = JSON.stringify({ version: 1, turns: list });
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, text, { mode: 0o600 });
        fs.renameSync(temp, file);
      } catch {
        // a turn's baseline that could not be kept is one the next Host does not have: its Last Turn says so
      }
    }, saveDelayMs);
    saving.unref?.();
  }

  /** The turns the last Host kept; a file that is missing or unreadable keeps none. A turn that was running then has no end, and says so. */
  function load() {
    if (!file) return;
    try {
      // a file past its own bound was not written by this Host: nothing is read from it
      if (fs.statSync(file).size > maxFileBytes) return;
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.turns)) return;
      const skipsOk = (/** @type {any} */ v) =>
        Array.isArray(v) &&
        v.length <= SKIPPED_KEPT &&
        v.every(
          (x) =>
            typeof x?.name === 'string' &&
            x.name &&
            x.name.length <= SKIPPED_NAME_MAX &&
            !x.name.includes('\0') &&
            typeof x.sig === 'string' &&
            x.sig.length <= 64,
        ) &&
        v.reduce((bytes, x) => bytes + Buffer.byteLength(x.name), 0) <= SKIPPED_BYTES_MAX
          ? v.map((x) => ({ name: x.name, sig: x.sig }))
          : [];
      const headOk = (/** @type {any} */ h) => h === null || (typeof h?.id === 'string' && TREE.test(h.id) && Number.isInteger(h.log));
      for (const t of saved.turns.slice(-keep)) {
        if (typeof t?.turnId !== 'string' || typeof t.chat !== 'string' || typeof t.cwd !== 'string') continue;
        if (!(t.start === null || TREE.test(t.start)) || !headOk(t.startHead)) continue;
        const ended = Object.hasOwn(t, 'end');
        if (ended && !(t.end === null || TREE.test(t.end))) continue;
        entries.set(t.turnId, {
          chat: t.chat,
          cwd: t.cwd,
          at: Number.isFinite(t.at) ? t.at : 0,
          start: t.start,
          startHead: t.startHead ?? null,
          skipped: skipsOk(t.skipped),
          // a turn the last Host stopped under has no end tree: nothing tells where it ended
          end: ended ? t.end : null,
          endHead: headOk(t.endHead) ? (t.endHead ?? null) : null,
          endSkipped: skipsOk(t.endSkipped),
        });
      }
    } catch {
      // nothing kept
    }
  }
  load();

  /** Takes away the temporary folders of snapshots a Host that died left behind (an hour old at least: another process's live ones stay). */
  async function sweep() {
    try {
      const dir = tmpdir();
      for (const name of await fsp.readdir(dir)) {
        if (!name.startsWith('mopilot-turn-')) continue;
        const old = await fsp.stat(path.join(dir, name)).then(
          (st) => now() - st.mtimeMs > STALE_MS,
          () => false,
        );
        // (a folder of another user's, or one in use, refuses: the others are still swept)
        if (old) await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch {
      // nothing to sweep, or nothing that could be
    }
  }
  void sweep();

  /** A message went to the chat, working in `cwd` (a later one that names none: the folder before). @param {string} chat @param {string | undefined} cwd */
  function note(chat, cwd) {
    if (typeof cwd === 'string' && cwd) folders.set(chat, cwd);
  }

  /** The turn started: its folder is snapshotted, without anything waiting for it. */
  function begin(/** @type {string} */ chat, /** @type {string} */ turnId) {
    const named = folders.get(chat);
    if (!named || entries.has(turnId) || working.has(turnId)) return;
    const job = (async () => {
      const cwd = await fsp.realpath(named).catch(() => named);
      const taken = await capture(cwd);
      entries.set(turnId, {
        chat,
        cwd,
        at: now(),
        start: taken?.tree ?? null,
        startHead: taken?.head ?? null,
        skipped: taken?.skipped ?? [],
      });
      trim();
      save();
    })().finally(() => working.delete(turnId));
    working.set(turnId, job);
  }

  /** The turn ended: its folder is snapshotted again, once the start snapshot is in. */
  function finish(/** @type {string} */ turnId) {
    const start = working.get(turnId);
    if (!start && !entries.has(turnId)) return;
    const job = (async () => {
      await start;
      const entry = entries.get(turnId);
      if (!entry || Object.hasOwn(entry, 'end')) return;
      // what the start left out is left out of the end too, so a file that grew past the limit during the turn is not a deletion
      const taken = entry.start
        ? await capture(
            entry.cwd,
            entry.skipped.map((s) => s.name),
          )
        : null;
      entry.end = taken?.tree ?? null;
      entry.endHead = taken?.head ?? null;
      entry.endSkipped = taken?.skipped ?? [];
      save();
    })().finally(() => working.delete(turnId));
    working.set(turnId, job);
  }

  /** The stream's events: every agent's turn starts and ends here. @param {any} event */
  function onEvent(event) {
    if (event?.kind === 'turnStart' && typeof event.key === 'string' && typeof event.turnId === 'string') begin(event.key, event.turnId);
    else if (event?.kind === 'turnEnd' && typeof event.turnId === 'string') finish(event.turnId);
  }

  /**
   * What turn `turnId` changed in the folder `p`: `{ isRepo: false }`, `{ isRepo: true, baseline: false }` when the Host has no usable start of that turn (never taken, too big, the Host stopped under it, git forgot its objects), else the patch (cut at MAX_PATCH, `truncated`) and, when snapshots left untracked files out (any left out on either side is out of both), `skipped: { count, paths }` (the first few) for those the turn touched. A turn still running is compared with the folder as it is now.
   * @param {{ path: string, turnId: string }} q
   */
  async function diff({ path: p, turnId }) {
    const dir = await hostFs.requireDirectory(p);
    const git = gitFor({ cut: false }, false, MAX_STEP);
    if (
      !(await git(dir, ['rev-parse', '--is-inside-work-tree']).then(
        (out) => out.trim() === 'true',
        () => false,
      ))
    )
      return { isRepo: false };
    await working.get(turnId);
    const entry = entries.get(turnId);
    if (!entry?.start || entry.cwd !== dir || entry.end === null) return { isRepo: true, baseline: false };
    let end = entry.end;
    let endHead = entry.endHead ?? null;
    let endSkipped = entry.endSkipped ?? [];
    if (end === undefined) {
      const current = await capture(
        dir,
        entry.skipped.map((s) => s.name),
      );
      if (!current) return { isRepo: true, baseline: false };
      end = current.tree;
      endHead = current.head;
      endSkipped = current.skipped;
    }
    const state = { cut: false };
    // a file left out of either snapshot is out of the diff on both sides (a file that grew past the limit would read as deleted, one that shrank under it as new)
    const before = new Map(entry.skipped.map((x) => [x.name, x.sig]));
    const after = new Map(endSkipped.map((x) => [x.name, x.sig]));
    const left = [...new Set([...before.keys(), ...after.keys()])];
    // only the ones the turn touched are said: one in a single list, or whose size or time is not the same in both (a big file that was there all along is no news)
    const touched = left.filter((name) => before.get(name) !== after.get(name));
    try {
      const patch = await compareTrees(
        gitFor(state, true, maxPatch),
        dir,
        entry.start,
        end,
        { before: entry.startHead, after: endHead },
        maxPatch,
        left,
      );
      // one bound for the whole patch, whatever the number of git calls it came from: past it, or where git cut a call, the patch ends with the last whole file (a first file alone past the bound is cut at a line)
      const over = patch.length > maxPatch;
      const cut = state.cut || over;
      const room = over ? patch.slice(0, maxPatch + 1) : patch;
      const fileEnd = cut ? room.lastIndexOf('\ndiff --git ') + 1 : 0;
      const whole = !cut ? patch : fileEnd > 0 ? room.slice(0, fileEnd) : room.slice(0, room.lastIndexOf('\n') + 1).slice(0, maxPatch);
      return {
        isRepo: true,
        baseline: true,
        patch: whole,
        truncated: cut,
        ...(touched.length ? { skipped: { count: touched.length, paths: touched.slice(0, SKIPPED_NAMED) } } : {}),
      };
    } catch {
      // the objects of a snapshot are gone (git gc), or the folder cannot be read now
      return { isRepo: true, baseline: false };
    }
  }

  return { note, onEvent, diff, size: () => entries.size };
}
