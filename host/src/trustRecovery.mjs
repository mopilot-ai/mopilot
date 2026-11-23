// Finish an already-authorized Host trust snapshot forward after a partial pairing/update-key write; every trust-lock entry replays pending intent before serving state.
import fs from 'node:fs';
import path from 'node:path';
import { checkedPairing, checkedUpdateKeys, writeTrustState } from './trustState.mjs';
import { createRequire } from 'node:module';
// a folder is synced where the system can (electron/platform/folderSync.cjs); a Host runs on Linux and macOS
const { syncFolder } = createRequire(import.meta.url)('../../electron/platform/folderSync.cjs');

/** @param {any} value */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () =>
  Object.assign(new Error('The pending Host trust change is invalid; trust remains blocked.'), { code: 'trust_recovery_failed' });
/** The new journal has a strict typed schema; legacy standalone files retain their existing decoder compatibility.
 * @param {any} snapshot
 */
function checkedSnapshot(snapshot) {
  if (!record(snapshot) || snapshot.version !== 1 || !record(snapshot.pairing) || !record(snapshot.keys)) throw invalid();
  const p = snapshot.pairing;
  const k = snapshot.keys;
  if (
    (p.codeHash !== null && typeof p.codeHash !== 'string') ||
    !Number.isFinite(p.expires) ||
    !Number.isFinite(p.wrong) ||
    !record(p.clients) ||
    Object.values(p.clients).some((v) => typeof v !== 'string' && !(record(v) && typeof v.key === 'string'))
  )
    throw invalid();
  if (!Array.isArray(k.added) || !Array.isArray(k.revoked) || !record(k.seen)) throw invalid();
  if (
    k.added.some((v) => !record(v) || typeof v.id !== 'string' || typeof v.pem !== 'string') ||
    k.revoked.some((v) => typeof v !== 'string') ||
    Object.values(k.seen).some((v) => !Number.isFinite(v))
  )
    throw invalid();
  return { pairing: checkedPairing(p), keys: checkedUpdateKeys(k) };
}

/** @param {string} configDir */
export function recoverTrust(configDir) {
  const pending = path.join(configDir, 'trust-pending.json');
  let snapshot;
  try {
    if (!fs.lstatSync(pending).isFile()) throw invalid();
    fs.chmodSync(pending, 0o600);
    snapshot = JSON.parse(fs.readFileSync(pending, 'utf8'));
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return;
    throw Object.assign(new Error('The pending Host trust change cannot be read; trust remains blocked.'), {
      code: 'trust_recovery_failed',
    });
  }
  const { pairing, keys } = checkedSnapshot(snapshot);
  writeTrustState(path.join(configDir, 'pairing.json'), pairing);
  writeTrustState(path.join(configDir, 'update-keys.json'), keys);
  fs.unlinkSync(pending);
  syncFolder(configDir, { fs });
}

/** The durable intent is the commit point; replay requires no new authority and cannot be skipped because the prior caller lost its acknowledgment.
 * @param {string} configDir
 * @param {{ pairing: import('./trustState.mjs').PairingState, keys: import('./trustState.mjs').UpdateKeyState }} snapshot
 */
export function commitTrust(configDir, snapshot) {
  const { pairing, keys } = checkedSnapshot({ version: 1, ...snapshot });
  writeTrustState(path.join(configDir, 'trust-pending.json'), { version: 1, pairing, keys });
  recoverTrust(configDir);
}
