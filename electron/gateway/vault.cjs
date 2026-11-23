// The connector token vault (#2999 C0; MoMo's connectors so far): each connector's OAuth tokens and access level in one sealed, owner-only file its owner names (sealedFile.cjs SealedJson), never in plain text and never handed to a model, a log or usage data: whoever calls the connector reads a token only to make the call itself.
const { SealedJson } = require('./sealedFile.cjs');

/**
 * @typedef {'blocked' | 'read' | 'ask'} Level what may be done with the account: nothing, read, or read and ask to change
 * @typedef {{ accessToken: string, refreshToken?: string, expiresAt?: number, scopes: string[], account?: string, level?: Level, savedAt: number }} TokenSet
 * @typedef {Record<string, TokenSet>} Tokens by connector id
 */

/** Connector ids: lowercase letters, digits and dashes. */
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The access levels (the sentinel's LEVELS); none saved means Read & ask to change. */
const LEVELS = Object.freeze(['blocked', 'read', 'ask']);

const record = (/** @type {unknown} */ v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {};

/** A saved token set, or null when it is not one (a damaged entry is dropped, not guessed at). @returns {TokenSet | null} */
function tokenSet(/** @type {unknown} */ v) {
  const t = record(v);
  if (typeof t.accessToken !== 'string' || !t.accessToken) return null;
  if (!Array.isArray(t.scopes) || !t.scopes.every((s) => typeof s === 'string')) return null;
  if (!Number.isFinite(t.savedAt)) return null;
  /** @type {TokenSet} */
  const out = { accessToken: t.accessToken, scopes: [...t.scopes], savedAt: t.savedAt };
  if (typeof t.refreshToken === 'string' && t.refreshToken) out.refreshToken = t.refreshToken;
  if (Number.isFinite(t.expiresAt)) out.expiresAt = t.expiresAt;
  if (typeof t.account === 'string' && t.account) out.account = t.account;
  if (LEVELS.includes(t.level)) out.level = t.level;
  return out;
}

/** The file's value as Tokens: only valid ids and token sets. @returns {Tokens} */
function shape(/** @type {unknown} */ value) {
  /** @type {Tokens} */
  const out = {};
  for (const [id, v] of Object.entries(record(value))) {
    const t = ID.test(id) ? tokenSet(v) : null;
    if (t) out[id] = t;
  }
  return out;
}

function checkId(/** @type {unknown} */ id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error(`Not a connector id: ${String(id)}`);
  return id;
}

class TokenVault {
  /**
   * @param {{ file: string, safeStorage: import('./sealedFile.cjs').SafeStorage | null | undefined, now?: () => number }} o
   *   file: the sealed file the vault keeps (an absolute path)
   */
  constructor({ file, safeStorage, now = Date.now }) {
    this.now = now;
    this.store = new SealedJson({ file, safeStorage, shape, now });
  }

  /** The connector's tokens, or null. Throws SealedUnavailableError without the OS key. @returns {TokenSet | null} */
  get(/** @type {string} */ id) {
    return this.store.read()[checkId(id)] ?? null;
  }

  /** Whether a connector has tokens saved (for status; never the tokens). */
  has(/** @type {string} */ id) {
    return this.get(id) !== null;
  }

  /** Saves the connector's tokens (replacing any), stamped with the time; the saved access level stays unless given. */
  put(/** @type {string} */ id, /** @type {Omit<TokenSet, 'savedAt'>} */ tokens) {
    const key = checkId(id);
    const t = tokenSet({ ...tokens, savedAt: this.now() });
    if (!t) throw new Error('A connector token set needs an access token and its scopes');
    return this.store.change((all) => {
      // read in the same change, so a level set while a refresh ran is kept
      const level = t.level ?? all[key]?.level;
      all[key] = level ? { ...t, level } : t;
    });
  }

  /** Sets a connected account's access level; nothing saved (disconnected meanwhile) changes nothing. */
  setLevel(/** @type {string} */ id, /** @type {Level} */ level) {
    const key = checkId(id);
    if (!LEVELS.includes(level)) throw new Error(`Not an access level: ${String(level)}`);
    return this.store.change((all) => {
      if (all[key]) all[key] = { ...all[key], level };
    });
  }

  /** Forgets the connector's tokens; nothing saved is not an error. */
  delete(/** @type {string} */ id) {
    const key = checkId(id);
    return this.store.change((all) => {
      delete all[key];
    });
  }

  /** Deletes every token (its owner's reset). */
  erase() {
    return this.store.erase();
  }
}

module.exports = { TokenVault, CONNECTOR_ID: ID, LEVELS };
