// A cross-process lock file whose owner record is published whole (written privately, then hard-linked into place), whose
// takeover removes only the record judged stale, and whose release removes only the caller's own record.
import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * The contract (#3646):
 * - Publication is atomic: the record `<pid> <token>\n` is written to a private file and linked to the lock path, which
 *   fails when the path exists. A reader sees no lock or a complete record, never a half-written one.
 * - A held lock is taken over only when its record is judged stale: `live(owner, ageMs)` says no, or the record cannot be
 *   read as an owner (a foreign or older writer's) and is older than `ambiguousMs`. A young unreadable record is held.
 * - Takeover runs under a guard (`<lock>.takeover`, the same protocol, taken over only when its holder's process is gone).
 *   It moves the lock aside, checks that it moved the very record it judged, and puts back any other.
 * - Release removes the lock only while it still holds the caller's record.
 * @typedef {{ pid: number, token: string | null }} Owner
 * @typedef {{ linkSync: typeof fs.linkSync, writeFileSync: typeof fs.writeFileSync, readFileSync: typeof fs.readFileSync,
 *   unlinkSync: typeof fs.unlinkSync, renameSync: typeof fs.renameSync, statSync: typeof fs.statSync }} LockFs
 * @typedef {{ owned: true, token: string, release: () => boolean } | { owned: false, owner: Owner | null, ageMs: number }} LockResult
 */

/** Whether a process with this id exists (a signal 0 reaches it, or is refused for lack of permission). */
export function pidAlive(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** The owner a record names; null for one that names none. A bare pid is an older writer's record. @returns {Owner | null} */
export function parseOwner(/** @type {string} */ text) {
  const m = /^(\d+)(?: (\S+))?\n?$/.exec(text);
  const pid = m ? Number(m[1]) : 0;
  return pid > 0 ? { pid, token: m?.[2] ?? null } : null;
}

const code = (/** @type {unknown} */ e) => /** @type {NodeJS.ErrnoException} */ (e)?.code;
const unique = () => `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;

/** Links `text` into place at `file`; false when the file exists. @param {LockFs} fsx */
function publish(fsx, /** @type {string} */ file, /** @type {string} */ text) {
  const draft = `${file}.${unique()}.draft`;
  fsx.writeFileSync(draft, text, { flag: 'wx' });
  /** @type {unknown} */
  let refused;
  try {
    fsx.linkSync(draft, file);
  } catch (e) {
    refused = e;
  }
  fsx.unlinkSync(draft);
  if (refused && code(refused) !== 'EEXIST') throw refused;
  return !refused;
}

/** The record at `file` and its age, or null when there is none. @param {LockFs} fsx */
function read(fsx, /** @type {string} */ file, /** @type {() => number} */ now) {
  try {
    const text = String(fsx.readFileSync(file, 'utf8'));
    const stat = fsx.statSync(file, { throwIfNoEntry: false });
    return stat ? { text, ageMs: Math.max(0, now() - stat.mtimeMs) } : null;
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
}

/** Removes `file` only while it holds `text`: moves it aside, and puts back a record that is not the one expected. @param {LockFs} fsx */
function removeIf(fsx, /** @type {string} */ file, /** @type {string} */ text) {
  const aside = `${file}.${unique()}.removed`;
  try {
    fsx.renameSync(file, aside);
  } catch (e) {
    if (code(e) === 'ENOENT') return false;
    throw e;
  }
  const moved = String(fsx.readFileSync(aside, 'utf8'));
  if (moved !== text) {
    // another record took its place between the check and the move: it goes back, unless a third one is already there
    try {
      fsx.linkSync(aside, file);
    } catch (e) {
      if (code(e) !== 'EEXIST') throw e;
    }
  }
  fsx.unlinkSync(aside);
  return moved === text;
}

/**
 * Tries once to take the lock at `file` (callers retry or wait as they need).
 * @param {string} file
 * @param {{ pid?: number, live?: (owner: Owner, ageMs: number) => boolean, ambiguousMs?: number, fsx?: LockFs, now?: () => number, guarded?: boolean }} [o]
 * @returns {LockResult}
 */
export function tryLock(file, o = {}) {
  const { pid = process.pid, live = (owner) => pidAlive(owner.pid), ambiguousMs = 5000, fsx = fs, now = Date.now, guarded = true } = o;
  const token = crypto.randomBytes(9).toString('hex');
  const mine = `${pid} ${token}\n`;
  const owned = () => ({ owned: /** @type {const} */ (true), token, release: () => removeIf(fsx, file, mine) });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (publish(fsx, file, mine)) return owned();
    const held = read(fsx, file, now);
    if (!held) continue; // released between the two steps: try again
    const owner = parseOwner(held.text);
    if (owner ? live(owner, held.ageMs) : held.ageMs <= ambiguousMs) return { owned: false, owner, ageMs: held.ageMs };
    // stale: under the guard, remove exactly the record judged stale, then publish again
    // (the guard itself is taken over without another guard: removeIf puts back a record that is not the one judged stale)
    const guard = guarded
      ? tryLock(`${file}.takeover`, { pid, fsx, now, ambiguousMs, guarded: false, live: (g) => pidAlive(g.pid) })
      : { owned: true, release: () => true };
    if (!guard.owned) return { owned: false, owner, ageMs: held.ageMs };
    try {
      removeIf(fsx, file, held.text);
    } finally {
      guard.release();
    }
  }
  const last = read(fsx, file, now);
  return { owned: false, owner: last ? parseOwner(last.text) : null, ageMs: last?.ageMs ?? 0 };
}
