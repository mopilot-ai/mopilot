// What MoMo wrote to Calendar and Reminders (#2139 P5), sealed in <momo dir>/writes.json (sealedFile.cjs): for each write its kind, the id EventKit gave the item and the title and time MoMo wrote, so an undo only touches an item MoMo made and only while it still matches. Entries are kept 30 days (the undo window); an undone entry stays until then, marked, so it can't be undone twice. Never what a source read.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { SealedJson } = require('../../gateway/sealedFile.cjs');

const FILE = 'writes.json';
/** How long a write can be undone. */
const KEEP_MS = 30 * 86_400_000;
const MAX_KEPT = 500;
/** What each kind of write is, and the source it wrote to. */
const KINDS = Object.freeze({ event: 'calendar', reminder: 'reminders', complete: 'reminders' });

/**
 * @typedef {{ id: string, kind: 'event' | 'reminder' | 'complete', itemId: string, title: string, at: number, start?: number, due?: number,
 *   chatId: string, undone?: number }} Written
 */

const isWritten = (/** @type {any} */ w) =>
  !!w &&
  typeof w.id === 'string' &&
  Object.hasOwn(KINDS, w.kind) &&
  typeof w.itemId === 'string' &&
  typeof w.title === 'string' &&
  Number.isFinite(w.at) &&
  typeof w.chatId === 'string';

/** The kept entries: the valid ones from the last 30 days, the newest MAX_KEPT. */
const shapeOf = (/** @type {unknown} */ v, /** @type {number} */ now) => {
  const all = Array.isArray(/** @type {any} */ (v)?.writes) ? /** @type {any} */ (v).writes : [];
  const kept = all.filter((/** @type {any} */ w) => isWritten(w) && w.at > now - KEEP_MS);
  return { writes: /** @type {Written[]} */ (kept.slice(-MAX_KEPT)) };
};

/** Emits 'changed' after a write is kept or marked undone (the Memory tab reads its list again). */
class WriteLedger extends EventEmitter {
  /** @param {{ dir: string, safeStorage: any, now?: () => number, newId?: () => string }} o */
  constructor({ dir, safeStorage, now = Date.now, newId = () => crypto.randomUUID() }) {
    super();
    this.now = now;
    this.newId = newId;
    this.file = new SealedJson({ file: path.join(dir, FILE), safeStorage, now, shape: shapeOf });
  }

  /** Every kept write, newest first; throws when the file can't be read now. @returns {Written[]} */
  list() {
    return [...this.file.read().writes].reverse();
  }

  /** One write by its id, or null. @returns {Written | null} */
  get(/** @type {string} */ id) {
    return this.file.read().writes.find((w) => w.id === id) ?? null;
  }

  /** Records a write; returns its id. @param {Omit<Written, 'id' | 'at'>} w */
  async add(w) {
    const id = this.newId();
    await this.file.change((v) => void v.writes.push({ ...w, id, at: this.now() }));
    this.emit('changed');
    return id;
  }

  /** Marks a write undone; false when it is not kept or already was. */
  async markUndone(/** @type {string} */ id) {
    const done = await this.file.change((v) => {
      const w = v.writes.find((x) => x.id === id);
      if (!w || w.undone !== undefined) return false;
      w.undone = this.now();
      return true;
    });
    if (done) this.emit('changed');
    return done;
  }

  /** Reset MoMo: deletes the file. */
  erase() {
    return this.file.erase();
  }
}

module.exports = { WriteLedger, KEEP_MS, KINDS, shapeOf };
