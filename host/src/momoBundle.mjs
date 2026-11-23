// The bundle of a move of MoMo's home (design 3.1): MoMo's sealed files and the key they are sealed with, closed to the target Host's one-time move key, so it can travel through the app and the relay and only the machine the person chose can open it. X25519 with a fresh key per bundle, HKDF-SHA256, ChaCha20-Poly1305 with the move id as associated data (a bundle made for one move opens for no other).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const INFO = Buffer.from('mopilot momo move v1');
/** The raw X25519 key sits at the end of its SPKI (public) and PKCS8 (private) DER encodings. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** @param {Buffer} raw a 32-byte X25519 public key */
const publicOf = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });

/** The same for an Ed25519 key. */
const ED_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * A move key: the target makes one per move and keeps the private halves in memory. `publicKey` closes the bundle to it (X25519);
 * `signKey` checks what it says afterwards (Ed25519: the receipt of the switch, the proof that it discarded the move), so the old home
 * deletes or resumes only on the target's own word. `fingerprint` of both is shown beside the machine's name.
 */
export function newMoveKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = /** @type {Buffer} */ (publicKey.export({ format: 'der', type: 'spki' })).subarray(SPKI_PREFIX.length);
  const sign = crypto.generateKeyPairSync('ed25519');
  const signRaw = /** @type {Buffer} */ (sign.publicKey.export({ format: 'der', type: 'spki' })).subarray(ED_SPKI_PREFIX.length);
  return {
    privateKey,
    publicKey: raw.toString('base64'),
    signPrivate: sign.privateKey,
    signKey: signRaw.toString('base64'),
    fingerprint: fingerprintOf(Buffer.concat([raw, signRaw])),
  };
}

/** What the target signs: the switch (`commit`) and the end of a move that did not happen (`discard`). Each names its move, so no receipt serves another. */
export const receiptText = (/** @type {'commit' | 'discard'} */ kind, /** @type {string[]} */ ...parts) =>
  Buffer.from([kind, ...parts].join(':'));

/** @param {import('node:crypto').KeyObject} signPrivate @param {Buffer} text @returns {string} */
export const signReceipt = (signPrivate, text) => crypto.sign(null, text, signPrivate).toString('base64');

/** Whether `signature` is the target's: its signing key (base64 raw) over `text`. @param {string} signKey @param {Buffer} text @param {unknown} signature */
export function receiptOk(signKey, text, signature) {
  if (typeof signature !== 'string') return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED_SPKI_PREFIX, Buffer.from(signKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, text, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Eight hex digits of the public key's hash in two groups ("4F2A-91C0"): short enough to read aloud on two screens. @param {Buffer} raw */
export function fingerprintOf(raw) {
  const hex = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** @param {Buffer} shared @param {string} moveId */
const keyFor = (shared, moveId) => Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(moveId), INFO, 32));

/**
 * Every file under `dir` (not those `skip` names, by path from `dir`), by relative path, with the sealed key beside them.
 * @param {string} dir @param {(rel: string) => boolean} skip
 * @returns {{ path: string, data: Buffer }[]}
 */
export function collectFiles(dir, skip) {
  /** @type {{ path: string, data: Buffer }[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(next)) continue;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push({ path: next, data: fs.readFileSync(path.join(dir, next)) });
    }
  };
  if (fs.existsSync(dir)) walk('');
  // by code unit, never by locale: the order is part of what the bundle's hash covers
  return out.sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
}

/**
 * @param {object} o
 * @param {string} o.moveId
 * @param {{ path: string, data: Buffer }[]} o.files MoMo's sealed files, as they are on the disk
 * @param {Buffer} o.dataKey the key those files are sealed with
 * @param {string} o.targetKey the target's move key (base64 of its raw public key)
 * @returns {{ sealed: string, hash: string }} `hash`: the SHA-256 of what is inside, which the target checks and the home record keeps
 */
export function sealBundle({ moveId, files, dataKey, targetKey }) {
  const inner = JSON.stringify({
    v: 1,
    moveId,
    dataKey: dataKey.toString('base64'),
    files: files.map((f) => ({ path: f.path, data: f.data.toString('base64') })),
  });
  const hash = crypto.createHash('sha256').update(inner).digest('hex');
  const peer = Buffer.from(targetKey, 'base64');
  if (peer.length !== 32) throw new Error('That is not a move key.');
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicOf(peer) });
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('chacha20-poly1305', keyFor(shared, moveId), nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(moveId));
  const body = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
  const ephRaw = /** @type {Buffer} */ (eph.publicKey.export({ format: 'der', type: 'spki' })).subarray(SPKI_PREFIX.length);
  return { sealed: Buffer.concat([ephRaw, nonce, cipher.getAuthTag(), body]).toString('base64'), hash };
}

/**
 * @param {object} o
 * @param {string} o.moveId @param {string} o.sealed @param {import('node:crypto').KeyObject} o.privateKey
 * @returns {{ files: { path: string, data: Buffer }[], dataKey: Buffer, hash: string }}
 */
export function openBundle({ moveId, sealed, privateKey }) {
  const raw = Buffer.from(sealed, 'base64');
  if (raw.length < 32 + 12 + 16) throw new Error('That bundle is not complete.');
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicOf(raw.subarray(0, 32)) });
  const decipher = crypto.createDecipheriv('chacha20-poly1305', keyFor(shared, moveId), raw.subarray(32, 44), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(moveId));
  decipher.setAuthTag(raw.subarray(44, 60));
  const inner = Buffer.concat([decipher.update(raw.subarray(60)), decipher.final()]).toString('utf8');
  const v = JSON.parse(inner);
  if (v?.v !== 1 || v.moveId !== moveId || !Array.isArray(v.files) || typeof v.dataKey !== 'string')
    throw new Error('That bundle is not one of this move.');
  const dataKey = Buffer.from(v.dataKey, 'base64');
  if (dataKey.length !== 32) throw new Error('That bundle carries no usable key.');
  return {
    dataKey,
    hash: crypto.createHash('sha256').update(inner).digest('hex'),
    files: v.files.map((/** @type {any} */ f) => ({ path: String(f.path), data: Buffer.from(String(f.data), 'base64') })),
  };
}

/** Whether a path from a bundle stays inside the folder it is written to: no absolute path, no `..`, no empty part. @param {string} rel */
export const safeRel = (rel) =>
  !!rel && !path.isAbsolute(rel) && rel.split('/').every((p) => p && p !== '.' && p !== '..') && !rel.includes('\\');
