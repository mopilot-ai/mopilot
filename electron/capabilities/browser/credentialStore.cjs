// MoPilot's own saved logins for the in-app browser (the agent's credential hand-off and the user's key button): per site origin, the password encrypted with Electron safeStorage; logins imported from another browser are marked with their source.
//
// Only main reads a saved password, to fill it into the page (credentials.cjs). The sheet in the chat
// lists a site's saved logins by username; neither the renderer nor the model ever gets a password.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { encryptForStore, canEncrypt } = require('../../platform/encryptedStore.cjs');
const { readCheckedStore } = require('../../platform/checkedStore.cjs');

/** Display readable entries, but grant writers ownership only after validating the entire saved list. */
function readList(file, what, validEntry, forChange = false) {
  const { data, error } = readCheckedStore(
    file,
    `the saved browser ${what}`,
    forChange
      ? (value) => {
          if (!Array.isArray(value)) throw new Error(`not a list of ${what}`);
          if (!value.every(validEntry)) throw new Error(`invalid entry in the list of ${what}`);
          return true;
        }
      : null,
  );
  if (forChange && error) throw new Error(`Couldn't read the saved ${what} (${error.message}), so they weren't changed`);
  return Array.isArray(data) ? data.filter(validEntry) : [];
}
const loginEntry = (e) => e && typeof e.id === 'string' && typeof e.origin === 'string';
const neverEntry = (e) => typeof e === 'string';

class CredentialStore {
  /** @param {{ file: string, safeStorage?: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } | null }} o */
  constructor({ file, safeStorage = null }) {
    this.file = file;
    this.safe = safeStorage;
    /** the sites the user told never to offer saving a password for */
    this.neverFile = file.replace(/\.json$/, '') + '-never.json';
  }

  /** Whether logins can be saved here (the OS encryption key is available). */
  available() {
    return canEncrypt(this.safe);
  }

  /**
   * The saved logins. A file that is there but can't be read (or isn't a list) reads as none, for showing and filling;
   * `forChange` throws instead, so a save or delete never writes over logins it couldn't read (a copy is kept).
   */
  #read(forChange = false) {
    return readList(this.file, 'logins', loginEntry, forChange);
  }

  #write(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(this.file, JSON.stringify(list));
  }

  /** A site's saved logins, without their passwords: [{ id, username }]. */
  list(origin) {
    return this.#read()
      .filter((e) => e.origin === origin)
      .map((e) => ({ id: e.id, username: String(e.username ?? '') }));
  }

  /** A saved login for `origin` only (a login saved for another site is never used): { username, password }, or null. */
  get(id, origin) {
    const e = this.#read().find((x) => x.id === id && x.origin === origin);
    if (!e || !this.available()) return null;
    try {
      return {
        username: String(e.username ?? ''),
        password: /** @type {any} */ (this.safe).decryptString(Buffer.from(String(e.secret), 'base64')),
      };
    } catch {
      return null;
    }
  }

  /** Saves (or replaces) a login for a site; false when it can't be saved. */
  save(origin, username, password) {
    if (!origin || !password) return false;
    const user = String(username ?? '');
    let list;
    try {
      list = this.#read(true).filter((e) => !(e.origin === origin && e.username === user));
    } catch {
      return false;
    }
    const encrypted = encryptForStore(this.safe, String(password));
    if (!encrypted.ok) return false;
    list.push({
      id: crypto.randomUUID(),
      origin,
      username: user,
      secret: encrypted.value,
      at: Date.now(),
    });
    try {
      this.#write(list);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Logins imported from another browser, in one write: a login for the same site and user name is replaced (the
   * other browser's is the one the user just chose). Null when logins can't be saved here (no OS encryption key):
   * nothing is written in the clear.
   * @param {{ origin: string, username: string, password: string }[]} logins
   * @param {string} source e.g. "import:chrome"
   * @returns {{ imported: number, replaced: number } | null}
   */
  saveMany(logins, source) {
    if (!this.available()) return null;
    const list = this.#read(true);
    let replaced = 0;
    /** the logins this import wrote (one site and user name named twice is one login) */
    const written = new Set();
    const now = Date.now();
    for (const l of logins) {
      if (!l?.origin || !l.password) continue;
      const user = String(l.username ?? '');
      const at = list.findIndex((e) => e.origin === l.origin && e.username === user);
      // a login the user saved themselves stays theirs (deleting imports never takes it away); it takes the new password
      const own = at >= 0 && !(typeof list[at].source === 'string' && list[at].source.startsWith('import:'));
      const key = `${l.origin}\u0000${user}`;
      if (at >= 0) {
        list.splice(at, 1);
        if (!written.has(key)) replaced++;
      }
      written.add(key);
      list.push({
        id: crypto.randomUUID(),
        origin: l.origin,
        username: user,
        secret: /** @type {any} */ (this.safe).encryptString(String(l.password)).toString('base64'),
        at: now,
        source: own ? 'local' : source,
      });
    }
    if (written.size) this.#write(list);
    return { imported: written.size, replaced };
  }

  /** Imported sources and how many logins each brought: [{ source, count }] (source without its "import:" prefix). */
  importedSources() {
    const by = new Map();
    for (const e of this.#read()) {
      const source = typeof e.source === 'string' && e.source.startsWith('import:') ? e.source.slice(7) : null;
      if (source) by.set(source, (by.get(source) ?? 0) + 1);
    }
    return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([source, count]) => ({ source, count }));
  }

  /** Forgets the logins an import brought (one source, or all). Returns how many. */
  deleteImported(source) {
    const list = this.#read(true);
    const kept = list.filter(
      (e) => !(typeof e.source === 'string' && (source ? e.source === `import:${source}` : e.source.startsWith('import:'))),
    );
    if (kept.length !== list.length) this.#write(kept);
    return list.length - kept.length;
  }

  /** The sites the user answered "Never" for when asked to save a password. */
  #never(forChange = false) {
    return readList(this.neverFile, 'password-save exclusions', neverEntry, forChange);
  }

  /** Whether the user told never to offer saving a password for `origin`. */
  isNever(origin) {
    return this.#never().includes(origin);
  }

  /** Never offers saving a password for `origin` again; false when that can't be written. */
  setNever(origin) {
    try {
      const list = this.#never(true);
      if (list.includes(origin)) return true;
      fs.mkdirSync(path.dirname(this.neverFile), { recursive: true });
      writePrivate(this.neverFile, JSON.stringify([...list, origin]));
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets a saved login; false when there was none. */
  remove(id) {
    const list = this.#read(true);
    const kept = list.filter((e) => e.id !== id);
    if (kept.length === list.length) return false;
    this.#write(kept);
    return true;
  }
}

module.exports = { CredentialStore };
