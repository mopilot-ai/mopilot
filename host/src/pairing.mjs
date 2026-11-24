// Pairing: a one-time code lets one client register its public key with the Host; after that only registered clients, proving they hold the key for this Host and this challenge, are served.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withTrustWrite } from './trustWrite.mjs';
import { createRefusalAudit } from './refusalAudit.mjs';
import { cleanName, readControllers, readPairing, writeControllers, writeTrustState } from './trustState.mjs';

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
 * @param {(e: { kind: string, by: { fingerprint: string, name: string, kind: string }, what?: Record<string, string | number> }) => void} [o.audit] told when a client is added or removed (the audit record's `client.added` and `client.removed`) and of a controller's sessions (`controller.connected`) and of the requests a kind was refused (`client.refused`, coalesced)
 * @param {(fingerprint: string) => void} [o.onSeen] told each time a registered client proves its key (update keys, not heard from for 180 days, are refused)
 */
export function createPairing({ configDir, now = Date.now, onSeen = () => undefined, audit = () => undefined }) {
  const file = path.join(configDir, 'pairing.json');
  const idFile = path.join(configDir, 'host-id');
  /** @type {string | null} */
  let ownId = null;
  /** Told when a client is forgotten, whichever way it happened (the owner, the CLI, a signed revocation). @type {((fingerprint: string, kind: string, link: string | undefined) => void)[]} */
  const forgotten = [];
  /** Told when a client is registered new, with the key it says it succeeds (a MoMo home key the owner's device registers as the old one's successor). @type {((fingerprint: string, kind: string, succeeds: string | undefined) => Promise<unknown> | undefined | void)[]} */
  const added = [];
  /** What the listeners of a client just added are still doing, by its fingerprint. @type {Map<string, Promise<unknown>>} */
  const settling = new Map();
  /** Single-use challenges, in memory only: a restart retires them. @type {Map<string, number>} */
  const nonces = new Map();

  const refusals = createRefusalAudit({ write: (e) => audit(e), now });
  const load = () => readPairing(configDir);
  /** The Macs paired by a code, from their own file (see trustState.readControllers). A key in both tables is the owner's client: the controller record is the one that gives way. */
  /** Whether a controller's record is one this Host believes (set when pairing by code is on: the record must carry the person's proof). @type {(record: import('./trustState.mjs').ClientRecord) => boolean} */
  let believed = () => true;
  /** @param {Record<string, import('./trustState.mjs').ClientRecord>} all */
  const believedOf = (all) => Object.fromEntries(Object.entries(all).filter(([, record]) => believed(record)));
  const controllers = () => {
    const mine = believedOf(readControllers(configDir));
    const clients = load().clients;
    return Object.fromEntries(Object.entries(mine).filter(([fingerprint]) => !Object.hasOwn(clients, fingerprint)));
  };
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
     * @param {{ name?: unknown, kind?: 'desktop' | 'phone' | 'cli' | 'home' | 'controller', addedBy?: string, succeeds?: string, link?: string, approval?: { text: string, sig: string } }} [o] `link`: the relay link a controller's credential made, kept with its record so that revoking it forgets the link
     */
    add(publicKey, { name = '', kind = 'desktop', addedBy = 'code', succeeds, link, approval } = {}) {
      const { fingerprint } = keyOf(publicKey);
      const state = load();
      const mine = controllers();
      if (Object.hasOwn(state.clients, fingerprint) || Object.hasOwn(mine, fingerprint)) return fingerprint;
      const record = {
        key: /** @type {string} */ (publicKey),
        name: cleanName(name),
        kind,
        addedAt: now(),
        addedBy,
        ...(kind === 'controller' && link ? { link } : {}),
        ...(kind === 'controller' && approval ? { approval } : {}),
      };
      if (kind === 'controller') writeControllers(configDir, { ...mine, [fingerprint]: record });
      else save({ ...state, clients: { ...state.clients, [fingerprint]: record } });
      audit({
        kind: 'client.added',
        by: { fingerprint, name: record.name, kind: record.kind },
        what: { addedBy, ...(succeeds ? { succeeds } : {}) },
      });
      // what a listener starts (a MoMo home key's handover of the lease) is waited for by whoever asked for the key (`settled`)
      const started = added.map((tell) => tell(fingerprint, kind, succeeds)).filter(Boolean);
      if (started.length > 0) settling.set(fingerprint, Promise.all(started));
      return fingerprint;
    },
    /** Every registered client, newest last. */
    list: () =>
      Object.entries({ ...load().clients, ...controllers() }).map(([fingerprint, { key: _key, ...rest }]) => ({ fingerprint, ...rest })),
    /** Who `fingerprint` is, or null when it is not registered. @param {string} fingerprint */
    principal(fingerprint) {
      const all = { ...load().clients, ...controllers() };
      const c = Object.hasOwn(all, fingerprint) ? all[fingerprint] : null;
      return c ? { fingerprint, name: c.name, kind: c.kind } : null;
    },
    /** Give a registered client a new name; false when it is not registered. @param {string} fingerprint @param {unknown} name */
    rename(fingerprint, name) {
      const state = load();
      const mine = controllers();
      if (Object.hasOwn(mine, fingerprint) && !Object.hasOwn(state.clients, fingerprint)) {
        writeControllers(configDir, { ...mine, [fingerprint]: { ...mine[fingerprint], name: cleanName(name) } });
        return true;
      }
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
      const mine = controllers();
      if (Object.hasOwn(mine, fingerprint) && !Object.hasOwn(state.clients, fingerprint)) {
        const { [fingerprint]: gone, ...rest } = mine;
        writeControllers(configDir, rest);
        audit({ kind: 'client.removed', by: { fingerprint, name: gone.name, kind: gone.kind } });
        for (const tell of forgotten) tell(fingerprint, gone.kind, gone.link);
        return true;
      }
      if (!Object.hasOwn(state.clients, fingerprint)) return false;
      const { [fingerprint]: _gone, ...clients } = state.clients;
      save({ ...state, clients });
      audit({ kind: 'client.removed', by: { fingerprint, name: _gone.name, kind: _gone.kind } });
      for (const tell of forgotten) tell(fingerprint, _gone.kind, undefined);
      return true;
    },
    /** From now on a controller's record is believed only when this says so (the proof the person gave): a record written by hand is no controller. @param {(record: import('./trustState.mjs').ClientRecord) => boolean} fn */
    believeControllers: (fn) => void (believed = fn),
    /** How many controller records the file holds, believed or not (a key is not enrolled while any is there). */
    controllerRecords: () => Object.keys(readControllers(configDir)).length,
    /** Hear every client that is registered new from now on. @param {(fingerprint: string, kind: string, succeeds: string | undefined) => Promise<unknown> | undefined | void} fn */
    onAdded: (fn) => void added.push(fn),
    /** What the listeners of a client just added were doing, once (so a request that adds a key can wait for it); none when they had nothing to do. @param {string} fingerprint */
    settled(fingerprint) {
      const done = settling.get(fingerprint);
      settling.delete(fingerprint);
      return done;
    },
    /** Hear every client that is forgotten from now on (a controller's relay link, when it had one, is the third thing told). @param {(fingerprint: string, kind: string, link: string | undefined) => void} fn */
    onForgotten: (fn) => void forgotten.push(fn),
    /** How many clients are registered. */
    paired: () => Object.keys(load().clients).length,
    /** Whether `fingerprint` is a registered client. @param {string} fingerprint */
    knows: (fingerprint) => Object.hasOwn(load().clients, fingerprint) || Object.hasOwn(controllers(), fingerprint),
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
      const mine = readControllers(configDir);
      if (Object.hasOwn(mine, fingerprint)) {
        const { [fingerprint]: _controller, ...rest } = mine;
        writeControllers(configDir, rest);
      }
      if (!known) audit({ kind: 'client.added', by: { fingerprint, name: record.name, kind: record.kind } });
      onSeen(fingerprint);
      return { fingerprint, name: record.name, kind: record.kind };
    },
    /** One line for the audit record (a method refused to a controller). @param {Parameters<typeof audit>[0]} e */
    record: (e) => (e.kind === 'client.refused' ? refusals.note(/** @type {any} */ (e)) : audit(e)),
    /** Accept a registered client that proves it holds its key. @param {{ publicKey: unknown, nonce: unknown, signature: unknown }} p */
    verify(p) {
      const fingerprint = prove('auth', p);
      const who = pairing.principal(fingerprint);
      if (!who) throw new PairingError('unknown_client', 'This client is not paired with the Host.');
      // every session of a controller (a Mac paired by a code) is on the record before it starts: with `audit.required`, a line that cannot be written ends it here
      if (who.kind === 'controller') audit({ kind: 'controller.connected', by: who });
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
        return Object.hasOwn(readPairing(configDir).clients, id) || Object.hasOwn(believedOf(readControllers(configDir)), id);
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
