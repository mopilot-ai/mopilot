// The highest epoch the Host has seen for each chat, kept in its own file and read on every check so a restart or a second process cannot forget it; a lower epoch is refused with the current one (docs: design/host/index.html, package 2.3).
import { createMapFile } from './mapFile.mjs';

/** A write from an owner the chat has moved past: not an error to retry, the caller learns `current`. */
export class StaleEpochError extends Error {
  /** @param {string} chatId @param {number} epoch @param {number} current */
  constructor(chatId, epoch, current) {
    super(`That chat is at epoch ${current}; epoch ${epoch} is no longer its owner.`);
    this.name = 'StaleEpochError';
    this.code = 'stale_epoch';
    this.chatId = chatId;
    this.current = current;
  }
}

/** The epoch file and its last good copy are both unreadable: nothing can be checked, so nothing is let through. */
export class EpochStoreError extends Error {
  /** @param {string} file */
  constructor(file) {
    super(`The epoch file ${file} cannot be read, so no write can be checked against it.`);
    this.name = 'EpochStoreError';
    this.code = 'epoch_store_unreadable';
  }
}

/** @param {unknown} v */
const validMap = (v) =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0);

/**
 * @param {string} file where the epochs live
 * @param {{ report: (problem: string) => void }} o told when the file was unreadable and the copy was used
 */
export function createEpochStore(file, { report }) {
  const { load, save } = createMapFile(file, { valid: validMap, kind: 'epoch', unreadable: (file) => new EpochStoreError(file), report });
  /** @type {Set<(chatId: string, epoch: number) => void>} */
  const advanced = new Set();
  return {
    /** Hears each time a chat's epoch moves forward (a new owner): what the old owner held is let go. @param {(chatId: string, epoch: number) => void} fn @returns {() => void} */
    onAdvance(fn) {
      advanced.add(fn);
      return () => void advanced.delete(fn);
    },
    /** Every chat the file holds an epoch for, with it. @returns {[string, number][]} */
    all: () => [...load()],
    /** The chat's highest epoch, 0 for one never seen. @param {string} chatId */
    current: (chatId) => load().get(chatId) ?? 0,
    /**
     * Lets a request through when its epoch is the chat's current one or newer (a newer one is recorded before this
     * returns, so the owner that moved on cannot come back); throws StaleEpochError for an older one.
     * @param {string} chatId @param {number} epoch
     */
    admit(chatId, epoch) {
      const map = load();
      const current = map.get(chatId) ?? 0;
      if (epoch < current) throw new StaleEpochError(chatId, epoch, current);
      if (epoch > current) {
        map.set(chatId, epoch);
        save(map);
        for (const fn of [...advanced]) fn(chatId, epoch);
      }
      return epoch;
    },
  };
}
