// Raw Host trust-file schemas and durable publication, shared by pairing, update keys and recovery; callers own the config-directory trust lock.
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_KINDS, clientNameOf as cleanName } from '../../shared/host/clients.mjs';
import { writePrivateDurable } from '../../electron/platform/durableFile.cjs';

/** @typedef {{ key: string, name: string, kind: 'desktop' | 'phone' | 'cli' | 'home' | 'controller' | 'unknown', addedAt: number, addedBy: string }} ClientRecord */
/** @typedef {{ codeHash: string | null, expires: number, wrong: number, clients: Record<string, ClientRecord> }} PairingState */
/** @typedef {{ added: { id: string, pem: string }[], revoked: string[], seen: Record<string, number> }} UpdateKeyState */

export { CLIENT_KINDS, cleanName };

/**
 * One client as the trust file holds it. The old form, a bare public key, is a desktop client with no name; a record whose kind is not one this Host knows is read as `unknown`, which every kind check refuses by default (it is no owner, no update key, sees only its own chats and has the phone's permission ceiling). Anything else is an unreadable file, never an empty client.
 * @param {unknown} v @returns {ClientRecord}
 */
export function clientOf(v) {
  if (typeof v === 'string') return { key: v, name: '', kind: 'desktop', addedAt: 0, addedBy: 'code' };
  const r = /** @type {any} */ (v);
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.key !== 'string') throw new Error('shape');
  return {
    key: r.key,
    name: cleanName(r.name),
    kind: CLIENT_KINDS.includes(r.kind) ? r.kind : 'unknown',
    addedAt: Number.isFinite(r.addedAt) ? r.addedAt : 0,
    addedBy: typeof r.addedBy === 'string' ? r.addedBy.slice(0, 200) : 'code',
  };
}

/** @param {any} s @returns {PairingState} */
export function checkedPairing(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.clients !== 'object' || s.clients === null) throw new Error('shape');
  return {
    codeHash: typeof s.codeHash === 'string' ? s.codeHash : null,
    expires: Number(s.expires) || 0,
    wrong: Number(s.wrong) || 0,
    clients: Object.fromEntries(Object.entries(s.clients).map(([fingerprint, v]) => [fingerprint, clientOf(v)])),
  };
}
/** @param {any} s @returns {UpdateKeyState} */
export function checkedUpdateKeys(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.added) || !Array.isArray(s.revoked) || typeof s.seen !== 'object' || s.seen === null)
    throw new Error('shape');
  return { added: s.added, revoked: s.revoked, seen: s.seen };
}
/** @template T @param {string} file @param {(s: any) => T} check @param {() => T} empty @param {string} kind @returns {T} */
function read(file, check, empty, kind) {
  try {
    return check(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return empty();
    throw new Error(`The ${kind} file ${file} cannot be read: ${/** @type {Error} */ (e).message}`);
  }
}
/** @param {string} configDir */
export const readPairing = (configDir) =>
  read(path.join(configDir, 'pairing.json'), checkedPairing, () => ({ codeHash: null, expires: 0, wrong: 0, clients: {} }), 'pairing');
/**
 * The Macs paired by a code (kind `controller`), kept in a file of their own that a Host from before them never reads, so a Host rolled back across this change has no controllers and each must pair again (fail closed; they are never read as a phone). A file that cannot be read is no controllers at all. A record is a controller whatever kind it says.
 * @param {string} configDir @returns {Record<string, ClientRecord>}
 */
export function readControllers(configDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'controllers.json'), 'utf8'));
    if (parsed?.v !== 1 || !parsed.controllers || typeof parsed.controllers !== 'object' || Array.isArray(parsed.controllers)) return {};
    /** @type {Record<string, ClientRecord>} */
    const out = {};
    for (const [fingerprint, v] of Object.entries(parsed.controllers)) {
      try {
        out[fingerprint] = { ...clientOf(v), kind: 'controller' };
      } catch {
        // one record that is not a client is no client; the rest stand
        continue;
      }
    }
    return out;
  } catch {
    return {};
  }
}
/** @param {string} configDir @param {Record<string, ClientRecord>} controllers */
export const writeControllers = (configDir, controllers) =>
  writeTrustState(path.join(configDir, 'controllers.json'), { v: 1, controllers });
/** @param {string} configDir */
export const readUpdateKeys = (configDir) =>
  read(path.join(configDir, 'update-keys.json'), checkedUpdateKeys, () => ({ added: [], revoked: [], seen: {} }), 'update key');
/** @param {string} file @param {object} state */
export const writeTrustState = (file, state) => writePrivateDurable(file, JSON.stringify(state), fs);
