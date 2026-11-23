// Pairing: a one-time code lets one client register its public key with the Host; after that only registered clients, proving they hold the key for this Host and this challenge, are served.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withTrustWrite } from './trustWrite.mjs';
import { cleanName, readPairing, writeTrustState } from './trustState.mjs';

/** A code is valid this long after the Host printed it. */
export const CODE_TTL_MS = 24 * 60 * 60 * 1000;
/** After this many wrong codes the code is retired and a new one must be printed on the machine. */
export const MAX_WRONG = 5;
/** A challenge is good for one answer, this long. */
export const NONCE_TTL_MS = 60_000;
const MAX_NONCES = 64;
/** Crockford's alphabet: no 0/O/1/I/L, so a code read off a screen is typed back right. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export class PairingError extends Error {
  /** @param {'wrong_code' | 'code_expired' | 'no_code' | 'bad_proof' | 'stale_challenge' | 'unknown_client'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

/** What a person typed or pasted, as the code it stands for: case, spaces and dashes do not matter. @param {unknown} v */
export const normalizeCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[\s-]/g, '') : '');

/** @param {string} s */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The client key a request names: an Ed25519 public key as base64 SPKI DER. @param {unknown} b64 */
function keyOf(b64) {
  try {
    if (typeof b64 !== 'string' || b64.length > 200) throw new Error('size');
    const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
    return { key, fingerprint: sha256(b64) };
  } catch {
    throw new PairingError('bad_proof', 'That client key is not one this Host accepts.');
  }
}

/**
 * @param {object} o
 * @param {string} o.configDir where `pairing.json` (0600) lives
 * @param {() => number} [o.now]
 * @param {(e: { kind: string, by: { fingerprint: string, name: string, kind: string } }) => void} [o.audit] told when a client is added or removed (the audit record's `client.added` and `client.removed`)
 * @param {(fingerprint: string) => void} [o.onSeen] told each time a registered client proves its key (update keys, not heard from for 180 days, are refused)
 */
export function createPairing({ configDir, now = Date.now, onSeen = () => undefined, audit = () => undefined }) {
  const file = path.join(configDir, 'pairing.json');
  const idFile = path.join(configDir, 'host-id');
  /** @type {string | null} */
  let ownId = null;
  /** Single-use challenges, in memory only: a restart retires them. @type {Map<string, number>} */
  const nonces = new Map();

  const load = () => readPairing(configDir);
  /** @param {ReturnType<typeof load>} state */
  function save(state) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeTrustState(file, state);
  }

  /** Spend a challenge: true when it was issued, not yet answered and not stale. @param {unknown} nonce */
  function spend(nonce) {
    const at = typeof nonce === 'string' ? nonces.get(nonce) : undefined;
    if (at === undefined) return false;
    nonces.delete(/** @type {string} */ (nonce));
    return now() - at < NONCE_TTL_MS;
  }

  /** This Host's own name for the proofs it is given: made once, kept beside the pairing. A client signs it with the challenge, so a proof made for one Host is worth nothing to another. */
  function hostId() {
    if (ownId) return ownId;
    try {
      const saved = fs.readFileSync(idFile, 'utf8').trim();
      if (/^[0-9a-f]{32}$/.test(saved)) return (ownId = saved);
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
    }
    const made = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(idFile, `${made}\n`, { mode: 0o600 });
    return (ownId = made);
  }

  /** The signature check both steps share. @param {string} purpose @param {{ publicKey: unknown, nonce: unknown, signature: unknown }} p */
  function prove(purpose, p) {
    const { key, fingerprint } = keyOf(p.publicKey);
    if (!spend(p.nonce)) throw new PairingError('stale_challenge', 'That challenge is not current. Ask for a new one.');
    const ok =
      typeof p.signature === 'string' &&
      crypto.verify(null, Buffer.from(`${purpose}\n${hostId()}\n${p.nonce}`), key, Buffer.from(p.signature, 'base64'));
    if (!ok) throw new PairingError('bad_proof', 'That client could not prove it holds its key.');
    return fingerprint;
  }

  const pairing = {
    /** A new one-time code, replacing any older one; shown once, only its hash is kept. */
    issueCode() {
      const bytes = crypto.randomBytes(12);
      const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
      save({ ...load(), codeHash: sha256(code), expires: now() + CODE_TTL_MS, wrong: 0 });
      return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
    },
    /** The public keys (base64 SPKI) of the registered clients. */
    publicKeys: () => Object.values(load().clients).map((c) => c.key),
    /** The public keys of the registered desktop clients: the only ones a Host takes an update from (a phone or the CLI never signs one). */
    desktopKeys: () =>
      Object.values(load().clients)
        .filter((c) => c.kind === 'desktop')
        .map((c) => c.key),
    /**
     * Register a client key without a code: a signed update that adds a key (key rotation) says this app's next key is trusted, and an app that can replace the Host's code may as well connect. A key already registered stays as it is (one record per key, its kind never changed by a later add). Answers its fingerprint.
     * @param {unknown} publicKey base64 SPKI DER of an Ed25519 key
     * @param {{ name?: unknown, kind?: 'desktop' | 'phone' | 'cli', addedBy?: string }} [o]
     */
    add(publicKey, { name = '', kind = 'desktop', addedBy = 'code' } = {}) {
      const { fingerprint } = keyOf(publicKey);
      const state = load();
      if (Object.hasOwn(state.clients, fingerprint)) return fingerprint;
      const record = {
        key: /** @type {string} */ (publicKey),
        name: cleanName(name),
        kind,
        addedAt: now(),
        addedBy,
      };
      save({ ...state, clients: { ...state.clients, [fingerprint]: record } });
      audit({ kind: 'client.added', by: { fingerprint, name: record.name, kind: record.kind } });
      return fingerprint;
    },
    /** Every registered client, newest last. */
    list: () => Object.entries(load().clients).map(([fingerprint, { key: _key, ...rest }]) => ({ fingerprint, ...rest })),
    /** Who `fingerprint` is, or null when it is not registered. @param {string} fingerprint */
    principal(fingerprint) {
      const c = Object.hasOwn(load().clients, fingerprint) ? load().clients[fingerprint] : null;
      return c ? { fingerprint, name: c.name, kind: c.kind } : null;
    },
    /** Give a registered client a new name; false when it is not registered. @param {string} fingerprint @param {unknown} name */
    rename(fingerprint, name) {
      const state = load();
      if (!Object.hasOwn(state.clients, fingerprint)) return false;
      save({
        ...state,
        clients: {
          ...state.clients,
          [fingerprint]: {
            ...state.clients[fingerprint],
            name: cleanName(name),
          },
        },
      });
      return true;
    },
    /** Forget a registered client, as a signed revocation or its owner says (a key that is not registered is left alone; answers whether one was forgotten). @param {string} fingerprint */
    remove(fingerprint) {
      const state = load();
      if (!Object.hasOwn(state.clients, fingerprint)) return false;
      const { [fingerprint]: _gone, ...clients } = state.clients;
      save({ ...state, clients });
      audit({ kind: 'client.removed', by: { fingerprint, name: _gone.name, kind: _gone.kind } });
      return true;
    },
    /** How many clients are registered. */
    paired: () => Object.keys(load().clients).length,
    /** Whether `fingerprint` is a registered client. @param {string} fingerprint */
    knows: (fingerprint) => Object.hasOwn(load().clients, fingerprint),
    /** This Host's name, which the proofs are signed over. */
    hostId,
    /** A fresh challenge for one pair or auth attempt. */
    challenge() {
      for (const [n, at] of nonces) if (now() - at >= NONCE_TTL_MS) nonces.delete(n);
      if (nonces.size >= MAX_NONCES) nonces.delete(/** @type {string} */ (nonces.keys().next().value));
      const nonce = crypto.randomBytes(16).toString('hex');
      nonces.set(nonce, now());
      return nonce;
    },
    /**
     * Register a client: it proves it holds the key it names and presents the code. A wrong code counts against the code.
     * A key that is already registered keeps its kind; the name is the one given now, when there is one.
     * @param {{ code: unknown, publicKey: unknown, nonce: unknown, signature: unknown, name?: unknown }} p
     */
    claim(p) {
      const fingerprint = prove('pair', p);
      const state = load();
      if (!state.codeHash) throw new PairingError('no_code', 'No pairing code is waiting. Run `mopilot-host pair` on the machine.');
      if (now() >= state.expires)
        throw new PairingError('code_expired', 'The pairing code expired. Run `mopilot-host pair` on the machine.');
      const given = Buffer.from(sha256(normalizeCode(p.code)));
      if (!crypto.timingSafeEqual(given, Buffer.from(state.codeHash))) {
        const wrong = state.wrong + 1;
        save({ ...state, wrong, ...(wrong >= MAX_WRONG ? { codeHash: null } : {}) });
        throw new PairingError(
          'wrong_code',
          wrong >= MAX_WRONG
            ? 'Too many wrong codes. Run `mopilot-host pair` on the machine for a new one.'
            : 'That is not the pairing code.',
        );
      }
      const known = Object.hasOwn(state.clients, fingerprint) ? state.clients[fingerprint] : null;
      const name = cleanName(p.name) || known?.name || '';
      const record = known
        ? { ...known, name }
        : {
            key: /** @type {string} */ (p.publicKey),
            name,
            kind: /** @type {const} */ ('desktop'),
            addedAt: now(),
            addedBy: 'code',
          };
      save({
        codeHash: null,
        expires: 0,
        wrong: 0,
        clients: { ...state.clients, [fingerprint]: record },
      });
      if (!known) audit({ kind: 'client.added', by: { fingerprint, name: record.name, kind: record.kind } });
      onSeen(fingerprint);
      return { fingerprint, name: record.name, kind: record.kind };
    },
    /** Accept a registered client that proves it holds its key. @param {{ publicKey: unknown, nonce: unknown, signature: unknown }} p */
    verify(p) {
      const fingerprint = prove('auth', p);
      const who = pairing.principal(fingerprint);
      if (!who) throw new PairingError('unknown_client', 'This client is not paired with the Host.');
      onSeen(fingerprint);
      return who;
    },
  };
  return {
    ...pairing,
    publicKeys: () => withTrustWrite(configDir, () => pairing.publicKeys()),
    knows: (/** @type {string} */ id) => withTrustWrite(configDir, () => pairing.knows(id)),
    paired: () => withTrustWrite(configDir, () => pairing.paired()),
    issueCode: () => withTrustWrite(configDir, () => pairing.issueCode()),
    hostId: () => withTrustWrite(configDir, () => pairing.hostId()),
    desktopKeys: () => withTrustWrite(configDir, () => pairing.desktopKeys()),
    list: () => withTrustWrite(configDir, () => pairing.list()),
    /** The fingerprint of every registered client: whose uploads a deleted chat may have left. */
    fingerprints: () => withTrustWrite(configDir, () => pairing.list().map((c) => c.fingerprint)),
    principal: (/** @type {string} */ id) => withTrustWrite(configDir, () => pairing.principal(id)),
    rename: (/** @type {string} */ id, /** @type {unknown} */ name) => withTrustWrite(configDir, () => pairing.rename(id, name)),
    /** Whether `fingerprint` is still registered, read without the write lock: every write replaces the file whole, so a read sees one state or the other. Used on each request of a live connection. @param {string} id */
    stillKnows: (id) => {
      try {
        return Object.hasOwn(readPairing(configDir).clients, id);
      } catch {
        return false;
      }
    },
    add: (/** @type {unknown} */ key, /** @type {Parameters<typeof pairing.add>[1]} */ o) =>
      withTrustWrite(configDir, () => pairing.add(key, o)),
    remove: (/** @type {string} */ id) => withTrustWrite(configDir, () => pairing.remove(id)),
    claim: (/** @type {Parameters<typeof pairing.claim>[0]} */ p) => withTrustWrite(configDir, () => pairing.claim(p)),
    verify: (/** @type {Parameters<typeof pairing.verify>[0]} */ p) => withTrustWrite(configDir, () => pairing.verify(p)),
  };
}
