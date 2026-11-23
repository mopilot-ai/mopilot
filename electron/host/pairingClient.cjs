// The app's side of pairing: one Ed25519 identity per install (kept in the user data dir), the proof it signs for a Host's challenge, and the two exchanges that use it (claim with a code, and auth afterwards).
const crypto = require('node:crypto');
const os = require('node:os');
const { fs } = require('../platform/ports/fs.cjs');
const { readStoreFile } = require('../platform/fsutil.cjs');
const { writeSecret, SecretUnavailableError } = require('../platform/secretFile.cjs');
const { HostError } = require('./interface.cjs');
const { helloParams, negotiate, parseParams, requireFeatures } = require('../../shared/host/schema.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { signManifest } = require('../../shared/host/updateSignature.mjs');

/** What a person typed or pasted, as the code it stands for (the Host normalizes the same way). @param {unknown} v */
const normalizeCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[\s-]/g, '') : '');

/** A key pair as the identity file keeps it: the public key as base64 SPKI DER (what a Host registers) and the private one as PKCS8 PEM. @typedef {{ publicKey: string, privateKey: string }} KeyPair */

/** The id of a key: what a Host calls it (a paired client's fingerprint). @param {string} publicKey base64 SPKI DER */
const idOf = (publicKey) => crypto.createHash('sha256').update(publicKey).digest('hex');
/** A new key pair. @returns {KeyPair} */
function makePair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: /** @type {string} */ (privateKey.export({ format: 'pem', type: 'pkcs8' })),
  };
}
/** The PEM of a base64 SPKI DER key, as a manifest carries a key to add. @param {string} publicKey */
const pemOf = (publicKey) =>
  crypto
    .createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    .export({ type: 'spki', format: 'pem' })
    .toString();

/** @param {any} d */
const isPair = (d) => typeof d?.privateKey === 'string' && typeof d?.publicKey === 'string';
const WHAT = 'this app’s Host key';
/** The file could not be read: an error naming it, after a copy is kept beside it. @param {string} file @param {unknown} error */
function unreadable(file, error) {
  try {
    fs.copyFileSync(file, `${file}.unreadable`, fs.constants.COPYFILE_EXCL);
  } catch (copyError) {
    noteIgnored(`keep a copy of ${WHAT} that could not be read`, copyError, ['EEXIST']);
  }
  return new HostError(
    'invalid',
    `This app's Host key cannot be read (${/** @type {Error} */ (error).message}). A copy was kept next to it.`,
  );
}

/**
 * The identity file: sealed with safeStorage as `{ v, enc: 'safe', data }` (secretFile.cjs). An earlier version kept
 * the pair in plain text, which is read once and saved sealed (`plain`). Null when there is none.
 * @param {string} file @param {import('../platform/secretFile.cjs').SafeStorage | null | undefined} safe
 * @returns {{ pair: any, plain: boolean } | null}
 */
function readKeyFile(file, safe) {
  const { data, error } = readStoreFile(
    file,
    'the Host client key',
    (d) => isPair(d) || (d?.enc === 'safe' && typeof d?.data === 'string'),
  );
  if (error) throw new HostError('invalid', `This app's Host key cannot be read (${error.message}). A copy was kept next to it.`);
  if (!data) return null;
  if (isPair(data)) return { pair: data, plain: true };
  let pair;
  try {
    // never a quiet new identity when it can't be opened (the keychain locked, another Mac's): every paired Host would refuse it
    if (!safe) throw new SecretUnavailableError(WHAT);
    pair = JSON.parse(safe.decryptString(Buffer.from(data.data, 'base64')));
  } catch (e) {
    throw unreadable(file, e);
  }
  if (!isPair(pair)) throw unreadable(file, new Error('Invalid saved state for the Host client key'));
  return { pair, plain: false };
}

/**
 * This install's identity: made once, then read back; a file that is there but unreadable is an error, never a quiet new identity (every paired Host would refuse it).
 * It is kept sealed with safeStorage, never in plain text: without the keychain a new or changed key is not saved, and says so. A file an earlier version wrote in plain text is used and saved sealed in its place.
 * Key rotation (see keyRotation.cjs) keeps up to two more keys in the same file: `next`, made when a rotation starts and added to every machine before anything changes, and `retiring`, the id of the key that was replaced with the machines that have not yet been told to drop it (its private half is not kept: every machine already knows the new key, so nothing needs it).
 * @param {string} file
 * @param {import('../platform/secretFile.cjs').SafeStorage | null | undefined} safe Electron's safeStorage
 */
function loadIdentity(file, safe) {
  const read = readKeyFile(file, safe);
  /** @type {KeyPair & { next?: KeyPair, retiring?: { id: string, machines: string[] } }} */
  let saved = read?.pair ?? makePair();
  const save = () => {
    try {
      writeSecret(file, JSON.stringify(saved), safe, WHAT);
    } catch (error) {
      if (error instanceof SecretUnavailableError)
        throw new HostError('invalid', `${error.message}. Try again once the keychain is unlocked.`);
      throw error;
    }
  };
  if (!read) save();
  else if (read.plain) {
    // the plain-text file of an earlier version is replaced by a sealed one; without the keychain it is used as it is until it can be
    try {
      save();
    } catch (error) {
      noteIgnored('seal this app’s Host key', error);
    }
  }
  const sign = (/** @type {KeyPair} */ pair, /** @type {Buffer} */ bytes) =>
    crypto.sign(null, bytes, crypto.createPrivateKey(pair.privateKey)).toString('base64');
  return {
    /** The key this app connects with and signs updates with now. */
    get publicKey() {
      return saved.publicKey;
    },
    /** Its id, as a Host knows it. */
    get keyId() {
      return idOf(saved.publicKey);
    },
    /** The signature of an update manifest made for one Host (shared/host/updateSignature.mjs): the Host takes an update from the app it is paired with. A manifest that names its key (`keyId`) names the current one. @param {Parameters<typeof signManifest>[0]} facts */
    signManifest: (facts) => signManifest(facts, crypto.createPrivateKey(saved.privateKey)),
    /** The proof of holding the key for one challenge of one Host: a signature over the purpose, that Host's name and the nonce, so a proof made for one Host is worth nothing to another. @param {'pair' | 'auth'} purpose @param {string} hostId @param {string} nonce */
    sign: (purpose, hostId, nonce) => sign(saved, Buffer.from(`${purpose}\n${hostId}\n${nonce}`)),
    /** The next key of a rotation under way, made on first ask and kept until the rotation ends: asked again after a failed attempt it is the same key. */
    startRotation() {
      const next = saved.next ?? makePair();
      if (!saved.next) {
        saved = { ...saved, next };
        save();
      }
      return { id: idOf(next.publicKey), pem: pemOf(next.publicKey) };
    },
    /** Every machine knows the next key: it becomes the current one, and the old key is kept as retiring for `machines`, which are still to be told to drop it. @param {string[]} machines */
    promote(machines) {
      if (!saved.next) throw new HostError('invalid', 'No rotation is under way.');
      const old = idOf(saved.publicKey);
      saved = { ...saved.next, ...(machines.length ? { retiring: { id: old, machines } } : {}) };
      save();
    },
    /** The key being retired and the machines that still trust it, or null. */
    retiring: () => (saved.retiring ? { id: saved.retiring.id, machines: [...saved.retiring.machines] } : null),
    /** A machine dropped the old key (or is gone): when none is left the retirement is over. @param {string} machine */
    retired(machine) {
      if (!saved.retiring) return;
      const machines = saved.retiring.machines.filter((m) => m !== machine);
      const { retiring: _old, ...rest } = saved;
      saved = machines.length ? { ...rest, retiring: { ...saved.retiring, machines } } : rest;
      save();
    },
  };
}

/** @typedef {ReturnType<typeof loadIdentity>} Identity */

/** The Host's reply or a thrown refusal: `request` resolves with the result and rejects with an Error that carries the Host's `code`. @typedef {(method: string, params?: object) => Promise<any>} Request */

/** This Mac's name as the Host lists it among its clients ("Work MacBook Pro"). */
const deviceName = () => os.hostname().replace(/\.local$/, '');

/**
 * The challenge of a Host: its nonce and the name it signs proofs over. An older Host names none, and a proof for it could be relayed to any other Host, so it is not answered.
 * @param {Request} request
 * @returns {Promise<{ nonce: string, hostId: string }>}
 */
async function challengeOf(request) {
  const c = await request('host.challenge');
  if (typeof c?.nonce !== 'string' || typeof c?.hostId !== 'string' || !/^[0-9a-f]{32}$/.test(c.hostId))
    throw new HostError('invalid', 'This machine runs an older Host that cannot be paired safely. Update it.');
  return { nonce: c.nonce, hostId: c.hostId };
}

/**
 * Register this install with a Host using the code the machine printed (or the user pasted). Answers the Host's result and its name, which the caller keeps: a later proof is made only for that Host.
 * @param {Request} request
 * @param {Identity} identity
 * @param {unknown} code
 * @param {string} [name] what the Host lists this install as (default: this Mac's name)
 */
async function pairWith(request, identity, code, name = deviceName()) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new HostError('invalid', 'Enter the pairing code the machine printed.');
  const { nonce, hostId } = await challengeOf(request);
  const result = await request('host.pair', {
    code: normalized,
    ...(name ? { name } : {}),
    publicKey: identity.publicKey,
    nonce,
    signature: identity.sign('pair', hostId, nonce),
  });
  return { ...result, hostId };
}

/**
 * Prove to a Host that has paired this install that it still holds the key. `expected` is the name the Host had when it was paired: a Host that answers with another name is not that machine, and nothing is signed for it (a compromised Host could otherwise pass another Host's challenge through this app and use the proof there). With no name kept yet (paired before names existed), the name given is kept by `keep`.
 * @param {Request} request @param {Identity & { pin?: { expected?: string | null, keep?: (hostId: string) => void } }} identity `identity.pin` says which Host this is (machines.cjs binds it per machine)
 */
async function authenticate(request, identity) {
  const { expected = null, keep = () => undefined } = identity.pin ?? {};
  const { nonce, hostId } = await challengeOf(request);
  if (expected && expected !== hostId)
    throw new HostError('invalid', 'This is not the machine this app paired with. Remove it and add it again.');
  if (!expected) keep(hostId);
  return request('host.auth', { publicKey: identity.publicKey, nonce, signature: identity.sign('auth', hostId, nonce) });
}

/**
 * This install's key for one machine: it also says which Host the machine has (kept at pairing) and what to do with a name heard for the first time, so a proof is made only for that Host.
 * @param {Identity} identity @param {string | null} expected @param {(hostId: string) => void} keep
 */
// the identity stays the prototype, not a copy: a connection that outlives a key rotation reads the key the app has now, so the key it names and the one it signs with are the same
const pinned = (identity, expected, keep) => Object.create(identity, { pin: { value: { expected, keep }, enumerable: true } });

/** The machines this app has told its name to since it started. @type {Set<string>} */
const introduced = new Set();
/**
 * Tell a Host that keeps a client table this Mac's name, once per run: a Host paired before names existed lists this Mac with none. A Host that cannot, or refuses, is left alone (a name is a label). Answers the session.
 * @template {{ call: (method: string, params?: object) => Promise<any> }} S
 * @param {string} id @param {S} session
 * @returns {Promise<S>}
 */
async function introduce(id, session) {
  if (introduced.has(id)) return session;
  introduced.add(id);
  try {
    const reply = await session.call('host.hello', { ...helloParams(), moved: [] });
    requireFeatures('host.clientRename', negotiate(helloParams(), parseParams('host.hello', reply)));
    await session.call('host.clientRename', { name: deviceName() });
  } catch (e) {
    noteIgnored('tell a Host this Mac’s name', e);
  }
  return session;
}

module.exports = {
  introduce,
  deviceName,
  pinned,
  loadIdentity,
  pairWith,
  authenticate,
  normalizeCode,
  idOf,
};
