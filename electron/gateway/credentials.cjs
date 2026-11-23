// The gateway's credential vault (#2999 C2): each managed server's credential (a bearer token, a user name and password, a URL parameter, or OAuth tokens) under the server's key, in one sealed, owner-only file of the gateway's own, never in plain text. Only the gateway's process reads it, to reach the server itself: no credential goes to a harness's env, arguments or config, a model, a log or a window (tests/gatewayCredentials.invariant.test.ts). A vault that can't be opened throws SealedUnavailableError, never reads as empty.
const { SealedJson } = require('./sealedFile.cjs');
const { oauthCredentialOf } = require('./oauthCredential.cjs');

/**
 * @typedef {{ type: 'bearer', token: string }} BearerCredential
 * @typedef {{ type: 'basic', username: string, password: string }} BasicCredential
 * @typedef {{ type: 'urlParam', param: string, value: string }} UrlParamCredential
 * @typedef {BearerCredential | BasicCredential | UrlParamCredential | import('./oauthCredential.cjs').OAuthCredential} Credential
 * @typedef {Credential & { savedAt: number }} SavedCredential
 */

const KEY_MAX = 8192;
const VALUE_MAX = 8192;

const record = (/** @type {unknown} */ v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {};
/** A value that goes into a header or a URL: no control characters, so it can't start another header. */
const value = (/** @type {unknown} */ v, max = VALUE_MAX) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;

/** A credential, or null when it isn't a valid one (a damaged entry is dropped, not guessed at). @returns {Credential | null} */
function credentialOf(/** @type {unknown} */ v) {
  const c = record(v);
  if (c.type === 'bearer') {
    const token = value(c.token);
    return token ? { type: 'bearer', token } : null;
  }
  if (c.type === 'basic') {
    const username = value(c.username, 256);
    const password = value(c.password);
    // a colon in the user name would move the split between the two
    return username && !username.includes(':') && password ? { type: 'basic', username, password } : null;
  }
  if (c.type === 'oauth') return oauthCredentialOf(c);
  if (c.type === 'urlParam') {
    const param = typeof c.param === 'string' && /^[A-Za-z0-9_.~-]{1,64}$/.test(c.param) ? c.param : null;
    const v2 = value(c.value);
    return param && v2 ? { type: 'urlParam', param, value: v2 } : null;
  }
  return null;
}

const keyOk = (/** @type {unknown} */ key) => typeof key === 'string' && key.length > 0 && key.length <= KEY_MAX;

/** The file's value: only valid keys and credentials. @returns {Record<string, SavedCredential>} */
function shape(/** @type {unknown} */ v) {
  /** @type {Record<string, SavedCredential>} */
  const out = {};
  for (const [key, x] of Object.entries(record(v))) {
    const c = keyOk(key) ? credentialOf(x) : null;
    const savedAt = record(x).savedAt;
    if (c && Number.isFinite(savedAt)) out[key] = { ...c, savedAt };
  }
  return out;
}

function checkKey(/** @type {unknown} */ key) {
  if (!keyOk(key)) throw new Error('Not a managed server');
  return /** @type {string} */ (key);
}

class CredentialVault {
  /** @param {{ file: string, safeStorage: import('./sealedFile.cjs').SafeStorage | null | undefined, now?: () => number }} o */
  constructor({ file, safeStorage, now = Date.now }) {
    this.now = now;
    this.store = new SealedJson({ file, safeStorage, shape, now });
  }

  /** The server's credential, or null. Throws SealedUnavailableError when the vault can't be opened. @returns {SavedCredential | null} */
  get(/** @type {string} */ key) {
    return this.store.read()[checkKey(key)] ?? null;
  }

  /** The kind of credential each server has saved (for status; never the values). @returns {Record<string, Credential['type']>} */
  kinds() {
    return Object.fromEntries(Object.entries(this.store.read()).map(([k, c]) => [k, c.type]));
  }

  /** Saves the server's credential, replacing any. */
  put(/** @type {string} */ key, /** @type {unknown} */ credential) {
    const k = checkKey(key);
    const c = credentialOf(credential);
    if (!c) return Promise.reject(new Error('That credential is incomplete or has characters a server can’t take'));
    return this.store.change((all) => {
      all[k] = { ...c, savedAt: this.now() };
    });
  }

  /**
   * Replaces the server's credential (with `next`, or forgets it for null) only while `test` holds for what is saved
   * now, in the same change: a refresh never overwrites a sign-out or a newer sign-in. Resolves whether it replaced.
   * @param {string} key @param {(saved: SavedCredential | null) => boolean} test @param {unknown} next
   */
  replaceIf(key, test, next) {
    const k = checkKey(key);
    const c = next === null ? null : credentialOf(next);
    if (next !== null && !c) return Promise.reject(new Error('That credential is incomplete or has characters a server can’t take'));
    return this.store.change((all) => {
      if (!test(all[k] ?? null)) return false;
      if (c) all[k] = { ...c, savedAt: this.now() };
      else delete all[k];
      return true;
    });
  }

  /** Forgets the server's credential; nothing saved is not an error. */
  delete(/** @type {string} */ key) {
    const k = checkKey(key);
    return this.store.change((all) => {
      delete all[k];
    });
  }
}

module.exports = { CredentialVault, credentialOf };
