// The Host's owner record per chat for a continue: a chat prepared here for a coming owner, released to another Host, or poisoned because it was continued elsewhere while this Host was away; kept in its own file next to the epochs (docs: design/host/index.html, package 3.1).
import { createMapFile } from './mapFile.mjs';

/** The owner file and its last good copy are both unreadable: no continue can be checked, so none is let through. */
export class OwnerStoreError extends Error {
  /** @param {string} file */
  constructor(file) {
    super(`The owner file ${file} cannot be read, so no continue can be checked against it.`);
    this.name = 'OwnerStoreError';
    this.code = 'owner_store_unreadable';
  }
}

const STATES = new Set(['prepared', 'released', 'poisoned']);
/** @param {unknown} v */
const validEntry = (v) =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  STATES.has(/** @type {any} */ (v).state) &&
  Number.isSafeInteger(/** @type {any} */ (v).epoch) &&
  /** @type {any} */ (v).epoch >= 0;
/** @param {unknown} v */
const validMap = (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(validEntry);

/**
 * @typedef {{ state: 'prepared', epoch: number, preparedId: string, harness: string, cwd: string, nativeId: string, at: number }
 *   | { state: 'released', epoch: number, preparedId: string, targetHostId: string, cleaned: boolean, at: number }
 *   | { state: 'poisoned', epoch: number, at: number }} OwnerRecord
 */

/**
 * @param {string} file where the records live
 * @param {{ report: (problem: string) => void }} o told when the file was unreadable and the copy was used
 */
export function createOwnerStore(file, { report }) {
  const { load, save } = createMapFile(file, { valid: validMap, kind: 'owner', unreadable: (file) => new OwnerStoreError(file), report });
  return {
    /** The chat's record, or null when it is neither prepared, released nor poisoned. A copy. @param {string} chatId @returns {OwnerRecord | null} */
    get(chatId) {
      const rec = load().get(chatId);
      return rec ? { ...rec } : null;
    },
    /** Replaces the chat's record: one atomic write. @param {string} chatId @param {OwnerRecord} record */
    put(chatId, record) {
      save(new Map(load()).set(chatId, { ...record }));
    },
    /** Forgets the chat's record. @param {string} chatId */
    remove(chatId) {
      const map = new Map(load());
      if (map.delete(chatId)) save(map);
    },
    /** Every record, for the sweep of expired preparations. @returns {[string, OwnerRecord][]} */
    entries: () => [...load()].map(([id, rec]) => [id, { ...rec }]),
  };
}
