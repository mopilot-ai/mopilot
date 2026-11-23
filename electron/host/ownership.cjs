// Which Host owns each chat, and its epoch: userData/host-ownership.json, a side file so projects.json and chat files stay untouched.
const { writeAtomic, readStoreFile } = require('../platform/fsutil.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/** @typedef {{ hostId: string, ownerHostId: string, epoch: number, folder: string | null, lostHost?: { sourceHostId: string, targetHostId: string, epoch: number, rev: number } }} OwnershipRecord */

const LOCAL_HOST_ID = 'local';
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
/** A chat continued without its source Host (it was offline): which Host, the epoch that replaced it, the last rev the client held from it, and the Host that took over. */
const validLost = (/** @type {any} */ lost) =>
  lost === undefined ||
  (isJsonRecord(lost) &&
    nonEmpty(lost.sourceHostId) &&
    nonEmpty(lost.targetHostId) &&
    Number.isSafeInteger(lost.epoch) &&
    Number(lost.epoch) > 0 &&
    Number.isSafeInteger(lost.rev) &&
    Number(lost.rev) >= 0);
const validEntry = (/** @type {any} */ entry) =>
  isJsonRecord(entry) &&
  nonEmpty(entry.hostId) &&
  nonEmpty(entry.ownerHostId) &&
  Number.isSafeInteger(entry.epoch) &&
  Number(entry.epoch) >= 0 &&
  (entry.folder === null || typeof entry.folder === 'string') &&
  validLost(entry.lostHost);
const validMap = (value) => isJsonRecord(value) && Object.values(value).every(validEntry);
const localRecord = () => ({ hostId: LOCAL_HOST_ID, ownerHostId: LOCAL_HOST_ID, epoch: 0, folder: null });
const pick = ({ hostId, ownerHostId, epoch, folder, lostHost }) => ({
  hostId,
  ownerHostId,
  epoch,
  folder,
  ...(lostHost
    ? { lostHost: { sourceHostId: lostHost.sourceHostId, targetHostId: lostHost.targetHostId, epoch: lostHost.epoch, rev: lostHost.rev } }
    : {}),
});

/**
 * chatId -> { hostId, ownerHostId, epoch, folder }. hostId is the Host the chat runs on now; ownerHostId is the Host that holds
 * it (they differ while a chat is handed over); the epoch counts ownership changes. This package stores them as given. An absent chat is local at epoch 0. Chat ids are opaque, so entries live in a
 * Map and are written with Object.fromEntries (a chat id like "__proto__" or "a|b" is an ordinary key).
 */
class OwnershipStore {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    /** @type {Error | null} why the saved file could not be used as is, as of the last read of the file; entries come from the last good copy, if any */
    this.error = null;
    /** @type {boolean} the file and its last good copy are both unreadable: writes refuse until reset() accepts the loss */
    this.lost = false;
    this.accepted = false;
    this.entries = this.load();
  }

  /** Accept that unreadable records are gone (a copy of the file is kept as .unreadable) so writes work again. */
  reset() {
    this.accepted = true;
  }

  /** The saved entries: the file, else the last good copy beside it, else none (the failure stays in `error`). */
  load() {
    const main = readStoreFile(this.file, 'host ownership', validMap);
    if (!main.error) {
      this.error = null;
      this.lost = false;
      this.accepted = false;
      return new Map(Object.entries(main.data ?? {}));
    }
    this.error = main.error;
    const backup = readStoreFile(`${this.file}.bak`, 'host ownership backup', validMap);
    // A missing copy is no recovery either: the main file is bad and nothing else holds the records.
    this.lost = !!backup.error || backup.data === null;
    return new Map(Object.entries(this.lost ? {} : backup.data));
  }

  /** Pick up what another store or process wrote: the cache is otherwise replaced only by this store's own writes. */
  refresh() {
    this.entries = this.load();
  }

  /** The record for a chat; a chat nobody claimed is local at epoch 0. A copy: callers cannot edit the cache. @returns {OwnershipRecord} */
  get(chatId) {
    const entry = this.entries.get(chatId);
    return entry ? pick(entry) : localRecord();
  }

  /** The chats a remote Host runs now, with the machine and the folder on it: what the app follows at startup. */
  remoteChats() {
    return [...this.entries]
      .filter(([, e]) => e.hostId !== LOCAL_HOST_ID)
      .map(([chatId, e]) => ({ chatId, hostId: e.hostId, folder: e.folder }));
  }

  /** Every chat that runs on a remote machine now (its owner is not this Mac), with that machine: what panels ask to tell a folder on a machine from one here. */
  owned() {
    return [...this.entries].filter(([, e]) => e.ownerHostId !== LOCAL_HOST_ID).map(([chatId, e]) => ({ chatId, hostId: e.ownerHostId }));
  }

  /** The chats continued without `hostId` while it was away: what its hello tells it when it returns. @param {string} hostId */
  lostFrom(hostId) {
    return [...this.entries]
      .filter(([, e]) => e.lostHost?.sourceHostId === hostId)
      .map(([chatId, e]) => ({
        chatId,
        epoch: /** @type {any} */ (e.lostHost).epoch,
        targetHostId: /** @type {any} */ (e.lostHost).targetHostId,
      }));
  }

  /**
   * Record that `hostId` runs the chat. The epoch only moves forward (a stale writer cannot take a chat back). The other
   * writers' entries on disk are re-read first, so two stores on one file keep each other's chats; a failed write leaves
   * the cache as it was.
   */
  set(chatId, record) {
    if (!nonEmpty(chatId) || !validEntry({ folder: null, ...record })) throw new Error('Invalid host ownership record');
    const next = pick({ folder: null, ...record });
    const prior = this.writable();
    if (next.epoch < (prior.get(chatId)?.epoch ?? 0)) throw new Error('Stale host ownership epoch');
    this.save(new Map(prior).set(chatId, next));
  }

  /** Forget a chat's record (it is local again). */
  remove(chatId) {
    const prior = this.writable();
    if (!prior.has(chatId)) return;
    const next = new Map(prior);
    next.delete(chatId);
    this.save(next);
  }

  /** The records on disk, for a write; refused while every copy is unreadable, so one new entry never replaces the lost rest. */
  writable() {
    const accepted = this.accepted;
    const prior = this.load();
    if (this.lost && !accepted) throw new Error('Host ownership records are unreadable');
    return prior;
  }

  save(next) {
    // The last good copy follows every write, so a main file that goes bad later still leaves the latest state to recover.
    const text = JSON.stringify(Object.fromEntries(next));
    writeAtomic(this.file, text);
    this.entries = next;
    this.error = null;
    writeAtomic(`${this.file}.bak`, text);
  }
}

module.exports = { OwnershipStore, LOCAL_HOST_ID };
