// Saved per-turn diffs, one small file per chat: lazy sync read of the chat being shown, async coalesced writes, caps and
// eviction, and a time-sliced one-time migration of the old whole-store codex-turn-diffs.json (#2544).
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { normalizeDiffCache } = require('./turnDiffCache.cjs');

/** What `read` gives, or null when it fails: the callers treat a missing or unreadable file alike. */
async function orNull(read) {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Newest turns kept per chat: older ones fall back to the harness's own diff. */
const MAX_TURNS_PER_CHAT = 200;
/** Characters kept per chat: the oldest turns go first, the newest always stays. */
const MAX_BYTES_PER_CHAT = 8 * 1024 * 1024;
/** A chat file untouched this long is dropped (its chat is gone or long forgotten). */
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
/** The folder's total; the least recently written files go first. */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** How long writes of one chat coalesce. */
const FLUSH_DELAY_MS = 300;
/** Longest stretch the migration scans before yielding the event loop. */
const SLICE_MS = 4;

/** The chat's turns without the oldest ones past the caps; the newest turn always stays. @param {Record<string, string>} turns */
function trimTurns(turns) {
  const ids = Object.keys(turns);
  let drop = Math.max(0, ids.length - MAX_TURNS_PER_CHAT);
  let bytes = 0;
  for (let i = ids.length - 1; i >= drop; i--) {
    bytes += turns[ids[i]].length;
    if (bytes > MAX_BYTES_PER_CHAT) {
      drop = Math.min(i + 1, ids.length - 1);
      break;
    }
  }
  if (!drop) return turns;
  const kept = Object.create(null);
  for (const id of ids.slice(drop)) kept[id] = turns[id];
  return kept;
}

/**
 * The top-level members of a JSON object as [keyText, valueText] (values are objects), scanned over the raw bytes in
 * slices so the event loop keeps running and the whole file is never decoded at once (every JSON delimiter is ASCII).
 * @param {Buffer} buf
 * @param {(entry: [string, string]) => Promise<void>} each
 * @returns {Promise<boolean>} false for text that is not a complete object of objects
 */
async function eachMember(buf, each) {
  const QUOTE = 34;
  const BACKSLASH = 92;
  const isBlank = (from, to) => buf.subarray(from, to).toString('latin1').trim() === '';
  const open = buf.indexOf('{');
  if (open < 0 || !isBlank(0, open)) return false;
  let i = open + 1;
  let sliceEnd = Date.now() + SLICE_MS;
  for (;;) {
    const keyStart = buf.indexOf('"', i);
    const closing = buf.indexOf('}', i);
    if (keyStart < 0 || (closing >= 0 && closing < keyStart)) return closing >= 0 && isBlank(closing + 1, buf.length);
    let p = keyStart + 1;
    for (; p < buf.length && buf[p] !== QUOTE; p++) if (buf[p] === BACKSLASH) p++;
    const lead = buf
      .subarray(p + 1, p + 1 + 64)
      .toString('latin1')
      .match(/^\s*:\s*\{/);
    const valueStart = p + (lead?.[0].length ?? Number.NaN);
    if (p >= buf.length || Number.isNaN(valueStart)) return false;
    let depth = 0;
    let q = valueStart;
    for (; q < buf.length; q++) {
      const c = buf[q];
      if (c === QUOTE) {
        for (q++; q < buf.length && buf[q] !== QUOTE; q++) if (buf[q] === BACKSLASH) q++;
      } else if (c === 123) depth++;
      else if (c === 125 && --depth === 0) break;
      if (Date.now() > sliceEnd) {
        await new Promise((r) => setImmediate(r));
        sliceEnd = Date.now() + SLICE_MS;
      }
    }
    if (q >= buf.length) return false;
    await each([buf.toString('utf8', keyStart, p + 1), buf.toString('utf8', valueStart, q + 1)]);
    i = q + 1;
  }
}

/** Merge the chat's file on disk under the turns written since (a chat written before the migration finished). */
function mergeUnder(disk, turns) {
  return Object.assign(Object.create(null), normalizeDiffCache({ x: disk }).x, turns);
}

/** @typedef {{ turns: Record<string, string>, timer: any, writing: boolean, again: boolean, premigration: boolean }} Entry */

class TurnDiffStore {
  /**
   * @param {string} dir the folder of the per-chat files
   * @param {string} [legacyFile] the old whole-store file to migrate
   * @param {(what: string, error: unknown) => void} [report] where a failure that is let go is noted
   * @param {<T>(label: string, fn: () => T) => T} [measure] runs a synchronous step under a label (the stall logger's)
   */
  constructor(dir, legacyFile, report = (what, error) => console.warn(`[ignored] ${what}: ${error}`), measure = (label, fn) => fn()) {
    this.report = report;
    this.measure = measure;
    this.dir = dir;
    this.legacyFile = /** @type {string} */ (legacyFile);
    /** @type {Map<string, Entry>} */
    this.pending = new Map();
    this.migrated = !legacyFile;
    /** settles once the old file is migrated or given up; never rejects */
    this.ready = legacyFile ? this.migrate() : this.evict().catch((error) => this.report('evict old turn diffs', error));
  }

  /** The chat's file text: the one long synchronous step of a save, under the stall logger's label. */
  encode(threadId, turns) {
    return this.measure('turnDiffs.write', () => JSON.stringify({ threadId, turns: trimTurns(turns) }));
  }

  fileOf(threadId) {
    return path.join(this.dir, `${crypto.createHash('sha1').update(threadId).digest('hex')}.json`);
  }

  /** The chat's saved turns, or null; what is waiting to be written comes first. */
  read(threadId) {
    const pending = this.pending.get(threadId);
    if (pending) return pending.turns;
    try {
      const body = JSON.parse(fs.readFileSync(this.fileOf(threadId), 'utf8'));
      return body?.threadId === threadId ? body.turns : null;
    } catch {
      return null;
    }
  }

  /** Replace the chat's saved turns: written soon, together with any write that follows. */
  write(threadId, turns) {
    const entry = this.pending.get(threadId) ?? { turns, timer: null, writing: false, again: false, premigration: !this.migrated };
    entry.turns = turns;
    this.pending.set(threadId, entry);
    if (entry.writing) entry.again = true;
    else if (!entry.timer) {
      entry.timer = setTimeout(() => void this.flushChat(threadId), FLUSH_DELAY_MS);
      entry.timer.unref?.();
    }
  }

  async flushChat(threadId) {
    const entry = /** @type {Entry} */ (this.pending.get(threadId));
    entry.timer = null;
    entry.writing = true;
    try {
      let turns = entry.turns;
      if (entry.premigration) {
        await this.ready;
        entry.premigration = false;
        const disk = JSON.parse((await orNull(() => fs.promises.readFile(this.fileOf(threadId), 'utf8'))) ?? 'null')?.turns;
        turns = mergeUnder(disk, entry.turns);
      }
      await this.putFile(this.fileOf(threadId), this.encode(threadId, turns));
    } catch (error) {
      this.report('save the turn diffs of a chat', error);
    }
    entry.writing = false;
    if (entry.again) {
      entry.again = false;
      await this.flushChat(threadId);
    } else this.pending.delete(threadId);
  }

  async putFile(file, text) {
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(tmp, text, { mode: 0o600 });
      await fs.promises.rename(tmp, file);
    } catch (error) {
      await fs.promises.rm(tmp, { force: true });
      throw error;
    }
  }

  /** Everything waiting, written now (a quit). */
  flushSync() {
    for (const [threadId, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      try {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const file = this.fileOf(threadId);
        let turns = entry.turns;
        if (entry.premigration) {
          const disk = (() => {
            try {
              return JSON.parse(fs.readFileSync(file, 'utf8'))?.turns;
            } catch {
              return null;
            }
          })();
          turns = mergeUnder(disk, entry.turns);
        }
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, this.encode(threadId, turns), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (error) {
        this.report('save the turn diffs of a chat at quit', error);
      }
    }
    this.pending.clear();
  }

  /** Move the old whole-store file into per-chat files without holding the event loop; then evict. */
  async migrate() {
    try {
      const bytes = await orNull(() => fs.promises.readFile(this.legacyFile));
      if (bytes !== null) {
        let unwritten = false;
        const ok = await eachMember(bytes, async ([keyText, valueText]) => {
          let threadId;
          let turns;
          try {
            threadId = JSON.parse(keyText);
            turns = normalizeDiffCache({ [threadId]: JSON.parse(valueText) })[threadId];
          } catch (error) {
            // a member that is not JSON has nothing to move
            this.report('read the turn diffs of a chat in the old file', error);
            return;
          }
          try {
            // turns saved since the old file was kept are newer than anything in it
            const file = this.fileOf(threadId);
            const newer = JSON.parse((await orNull(() => fs.promises.readFile(file, 'utf8'))) ?? 'null')?.turns;
            await this.putFile(file, this.encode(threadId, mergeUnder(turns, newer)));
          } catch (error) {
            unwritten = true;
            this.report('migrate the turn diffs of a chat', error);
          }
        });
        // a chat that could not be written keeps the old file for the next start
        if (ok && unwritten) this.report('migrate the saved turn diffs', new Error('some chats were not written; the old file stays'));
        else if (ok) await fs.promises.rm(this.legacyFile, { force: true });
        else await fs.promises.rename(this.legacyFile, `${this.legacyFile}.corrupt`);
      }
    } catch (error) {
      this.report('migrate the saved turn diffs', error);
    }
    this.migrated = true;
    await this.evict().catch((error) => this.report('evict old turn diffs', error));
  }

  /** Drop files untouched for MAX_AGE_MS, then the least recently written until the folder fits MAX_TOTAL_BYTES. */
  async evict(now = Date.now()) {
    const names = (await orNull(() => fs.promises.readdir(this.dir))) ?? [];
    const files = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      const stat = await orNull(() => fs.promises.stat(file));
      if (stat?.isFile()) files.push({ file, mtime: stat.mtimeMs, size: stat.size });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    for (const f of files) {
      total += f.size;
      if (now - f.mtime > MAX_AGE_MS || total > MAX_TOTAL_BYTES) await fs.promises.rm(f.file, { force: true });
    }
  }
}

module.exports = { TurnDiffStore, trimTurns, MAX_TURNS_PER_CHAT, MAX_BYTES_PER_CHAT, MAX_AGE_MS, MAX_TOTAL_BYTES };
