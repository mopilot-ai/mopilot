// Computer History's store (#1363), on this Mac only: <userData>/computer-history/settings.json and one file per day under days/, each line an entry encrypted with Electron safeStorage (the key stays in the Keychain under MoPilot's identity), folders 0700 and files 0600. Nothing is written in plain text when encryption is unavailable; an unreadable settings file reads as off and is never saved over until the user changes a setting; retention, delete-day and delete-all remove whole day files.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate, readStoreFile } = require('../platform/fsutil.cjs');
const { encryptForStore, canEncrypt } = require('../platform/encryptedStore.cjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { DEFAULT_SETTINGS, normalizeSettings } = require('./policy.cjs');
const { dayKey, isDayKey, newestDayFirst, readEntry } = require('./segments.cjs');

/**
 * @typedef {import('./policy.cjs').Settings} Settings
 * @typedef {import('./segments.cjs').Entry} Entry
 * @typedef {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} SafeStorage
 */

/** A store failure with a stable code Settings turns into a sentence. */
class StoreError extends Error {
  /**
   * @param {string} message
   * @param {'store_unavailable' | 'invalid_day'} code
   * @param {Entry[] | null} [unwritten] the entries of an append that did not reach the disk (the others did)
   */
  constructor(message, code, unwritten = null) {
    super(message);
    this.code = code;
    this.unwritten = unwritten;
  }
}

class HistoryStore {
  /** @param {{ dir: string, safeStorage: SafeStorage | null }} o */
  constructor({ dir, safeStorage }) {
    this.dir = dir;
    this.days = path.join(dir, 'days');
    this.settingsFile = path.join(dir, 'settings.json');
    this.safe = safeStorage;
    /** @type {Error | null} why settings.json could not be read, until the user saves new settings */
    this.settingsError = null;
  }

  /** @returns {Settings} the saved settings; off when there are none or they can't be read */
  readSettings() {
    const { data, error } = readStoreFile(this.settingsFile, 'the Computer History settings');
    this.settingsError = error;
    return error ? { ...DEFAULT_SETTINGS } : normalizeSettings(data);
  }

  /** @param {Settings} settings @returns {Settings} what was saved */
  writeSettings(settings) {
    const s = normalizeSettings(settings);
    this.#ensure(this.dir);
    writePrivate(this.settingsFile, `${JSON.stringify(s, null, 2)}\n`);
    this.settingsError = null;
    return s;
  }

  /** Whether entries can be written now (safeStorage has its key). */
  canWrite() {
    return canEncrypt(this.safe);
  }

  /**
   * Appends entries to their day files, encrypted; nothing is written unless every one could be encrypted. When a
   * day's file can't be written, the error names the entries that were not (`unwritten`), so a retry adds only those.
   * @param {Entry[]} entries
   */
  append(entries) {
    /** @type {Map<string, { lines: string[], entries: Entry[] }>} */
    const byDay = new Map();
    for (const e of entries) {
      const line = encryptForStore(this.safe, JSON.stringify(e));
      if (!line.ok)
        throw new StoreError('Computer History could not encrypt what it recorded, so it saved nothing', 'store_unavailable', entries);
      const day = dayKey(e.start);
      const d = byDay.get(day) ?? { lines: [], entries: [] };
      d.lines.push(line.value);
      d.entries.push(e);
      byDay.set(day, d);
    }
    if (!byDay.size) return;
    /** @type {Entry[]} */
    const unwritten = [];
    let failure = null;
    for (const [day, d] of byDay) {
      try {
        this.#ensure(this.days);
        fs.appendFileSync(this.#dayFile(day), `${d.lines.join('\n')}\n`, { mode: 0o600 });
      } catch (error) {
        failure ??= error;
        unwritten.push(...d.entries);
      }
    }
    if (failure)
      throw new StoreError(`Computer History could not save what it recorded: ${messageOf(failure)}`, 'store_unavailable', unwritten);
  }

  /**
   * One day's entries, in the order they were written; lines that can't be decrypted or read are counted, never
   * dropped from the file.
   * @param {string} day
   * @returns {{ entries: Entry[], unreadable: number }}
   */
  readDay(day) {
    let text;
    try {
      text = fs.readFileSync(this.#dayFile(day), 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return { entries: [], unreadable: 0 };
      throw error;
    }
    const entries = [];
    let unreadable = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const e = this.#decrypt(line);
      if (e) entries.push(e);
      else unreadable++;
    }
    return { entries, unreadable };
  }

  /** The days with a file, newest first. */
  listDays() {
    let names;
    try {
      names = fs.readdirSync(this.days);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((n) => n.endsWith('.jsonl') && isDayKey(n.slice(0, -6)))
      .map((n) => n.slice(0, -6))
      .sort(newestDayFirst);
  }

  /** Removes one day's file. */
  deleteDay(day) {
    fs.rmSync(this.#dayFile(day), { force: true });
  }

  /** Removes every day's file (settings stay, so the allow list is not lost). */
  deleteAll() {
    fs.rmSync(this.days, { recursive: true, force: true });
  }

  /**
   * Removes the days older than the retention: today and the `days - 1` before it stay.
   * @param {number} days
   * @param {number} now
   * @returns {string[]} the days removed
   */
  prune(days, now) {
    const d = new Date(now);
    const cutoff = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime());
    const old = this.listDays().filter((day) => day < cutoff);
    for (const day of old) this.deleteDay(day);
    return old;
  }

  /** @param {string} line @returns {Entry | null} */
  #decrypt(line) {
    try {
      return readEntry(JSON.parse(/** @type {SafeStorage} */ (this.safe).decryptString(Buffer.from(line, 'base64'))));
    } catch (error) {
      // the line stays in the file; the day reads with it counted as unreadable
      noteIgnored('read a Computer History entry', error);
      return null;
    }
  }

  /** @param {string} day */
  #dayFile(day) {
    if (!isDayKey(day)) throw new StoreError(`Not a day: ${String(day).slice(0, 40)}`, 'invalid_day');
    return path.join(this.days, `${day}.jsonl`);
  }

  /** @param {string} dir */
  #ensure(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

module.exports = { HistoryStore, StoreError };
