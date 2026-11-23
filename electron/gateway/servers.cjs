// The MCP servers the gateway runs for every chat (#2999 C2): which servers are managed (none until the user turns one on), each with its launch (a command, its arguments and declared env, or a streamable HTTP URL and headers) and the kind of credential it takes, in one sealed, owner-only file of the gateway's own (outside MoMo's folder, so Reset MoMo keeps it). A server's key is a pure function of its launch (shared/identityKey.mjs), so its tools keep their names across sessions and app runs.
const { SealedJson } = require('./sealedFile.cjs');
const { identityKey } = require('../../shared/identityKey.mjs');

/**
 * @typedef {import('./catalog.cjs').StdioLaunch} StdioLaunch
 * @typedef {import('./catalog.cjs').HttpLaunch} HttpLaunch
 * @typedef {'none' | 'bearer' | 'basic' | 'urlParam' | 'oauth'} AuthType
 * @typedef {{ key: string, name: string, launch: StdioLaunch | HttpLaunch, auth: AuthType, addedAt: number }} ManagedServer
 * @typedef {{ name: string, launch: StdioLaunch | HttpLaunch, auth?: AuthType }} ServerSpec what the user adds
 */

/** The kinds of credential a server may take; a stdio server takes none (its declared env is its own). */
const AUTH_TYPES = Object.freeze(/** @type {AuthType[]} */ (['none', 'bearer', 'basic', 'urlParam', 'oauth']));
const NAME_MAX = 64;
const TEXT_MAX = 4096;
const LIST_MAX = 64;

const record = (/** @type {unknown} */ v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null;
const text = (/** @type {unknown} */ v, max = TEXT_MAX) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
/** No control characters: a value that ends up in a header or a process's argv stays one value. */
const plain = (/** @type {string} */ s) => !/[\u0000-\u001f\u007f]/.test(s);

/** A map of string values with plain names (env or headers), or null when it isn't one. */
function stringMap(/** @type {unknown} */ v, /** @type {RegExp} */ name) {
  const r = v === undefined ? {} : record(v);
  if (!r) return null;
  const entries = Object.entries(r);
  if (entries.length > LIST_MAX) return null;
  for (const [k, x] of entries) if (!name.test(k) || typeof x !== 'string' || x.length > TEXT_MAX || !plain(x)) return null;
  return Object.fromEntries(entries);
}

/** Whether a URL may be a managed server's: https, or http to this Mac only; never with a user name or password in it. */
function serverUrl(/** @type {unknown} */ v) {
  const s = text(v);
  if (!s || !plain(s)) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  url.hash = '';
  return url.href;
}

/** A launch as the store keeps it, or null when it isn't a valid one. @returns {StdioLaunch | HttpLaunch | null} */
function launchOf(/** @type {unknown} */ v) {
  const l = record(v);
  if (l?.type === 'stdio') {
    const command = text(l.command);
    const args =
      Array.isArray(l.args) && l.args.length <= LIST_MAX && l.args.every((a) => typeof a === 'string' && a.length <= TEXT_MAX && plain(a))
        ? [...l.args]
        : null;
    const env = stringMap(l.env, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    return command && plain(command) && args && env ? { type: 'stdio', command, args, env } : null;
  }
  if (l?.type === 'http') {
    const url = serverUrl(l.url);
    const headers = stringMap(l.headers, /^[A-Za-z0-9-]{1,128}$/);
    return url && headers ? { type: 'http', url, headers } : null;
  }
  return null;
}

/** A server's key: what identifies it whatever it is called, a structured tuple of its transport and target. */
function serverKey(/** @type {StdioLaunch | HttpLaunch} */ launch) {
  return launch.type === 'stdio' ? identityKey('stdio', launch.command, ...launch.args) : identityKey('http', launch.url);
}

/** A spec the user added, as a server to keep, or a reason it isn't one. @returns {{ server: Omit<ManagedServer, 'addedAt'> } | { error: string }} */
function checkSpec(/** @type {unknown} */ v) {
  const s = record(v);
  const name = text(s?.name, NAME_MAX);
  if (!name || !plain(name)) return { error: 'A server needs a name of at most 64 characters' };
  const launch = launchOf(s?.launch);
  if (!launch) return { error: 'A server needs a command, or an https address (http only on this Mac)' };
  const auth = s?.auth === undefined ? 'none' : s.auth;
  if (!AUTH_TYPES.includes(auth)) return { error: 'Not a kind of sign-in the gateway takes' };
  if (launch.type === 'stdio' && auth !== 'none') return { error: 'A server that runs as a command takes no sign-in: its env is its own' };
  return { server: { key: serverKey(launch), name, launch, auth } };
}

/** The file's value as servers by key: only valid entries, each under the key its launch makes (B1: a damaged entry is dropped). */
function shape(/** @type {unknown} */ value) {
  /** @type {Record<string, ManagedServer>} */
  const out = {};
  for (const v of Object.values(record(value) ?? {})) {
    const checked = checkSpec(v);
    const addedAt = record(v)?.addedAt;
    if ('server' in checked && Number.isFinite(addedAt)) out[checked.server.key] = { ...checked.server, addedAt };
  }
  return out;
}

class ManagedServers {
  /** @param {{ file: string, safeStorage: import('./sealedFile.cjs').SafeStorage | null | undefined, now?: () => number }} o */
  constructor({ file, safeStorage, now = Date.now }) {
    this.now = now;
    this.store = new SealedJson({ file, safeStorage, shape, now });
  }

  /** Every managed server, oldest first. Throws SealedUnavailableError when the file can't be opened (never read as none). @returns {ManagedServer[]} */
  list() {
    return Object.values(this.store.read()).sort((a, b) => a.addedAt - b.addedAt || (a.key < b.key ? -1 : 1));
  }

  /** @returns {ManagedServer | null} */
  get(/** @type {string} */ key) {
    return this.store.read()[key] ?? null;
  }

  /** Turns a server on; one already managed under the same key is refused. @returns {Promise<ManagedServer>} */
  add(/** @type {unknown} */ spec) {
    const checked = checkSpec(spec);
    if ('error' in checked) return Promise.reject(new Error(checked.error));
    const server = { ...checked.server, addedAt: this.now() };
    return this.store.change((all) => {
      if (all[server.key]) throw new Error(`${all[server.key].name} already runs through the gateway`);
      all[server.key] = server;
      return server;
    });
  }

  /** Stops managing a server; one not managed is not an error. */
  remove(/** @type {string} */ key) {
    return this.store.change((all) => {
      delete all[key];
    });
  }
}

module.exports = { ManagedServers, AUTH_TYPES, serverKey, checkSpec, launchOf, serverUrl };
