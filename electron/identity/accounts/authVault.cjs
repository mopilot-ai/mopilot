// Credentials of the Codex accounts MoPilot adds (<userData>/accounts/<id>): kept encrypted at rest in auth.json.enc (safeStorage, secretFile.cjs). The plain auth.json the Codex CLI reads exists only while that account's helper app-server runs: open() writes it before the helper starts and seal() encrypts what the helper left and deletes it when the helper exits; sealAll() does the same at startup for what an earlier run (or version) left. The CLI's own home ($CODEX_HOME) is Codex's and is never touched. @host-portable: loads in the Host process without Electron (host/boundary.json).
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { readSecret, writeSecret, canEncrypt } = require('../../platform/secretFile.cjs');

/** @typedef {import('../../platform/secretFile.cjs').SafeStorage} SafeStorage */

const PLAIN = 'auth.json';
const SEALED = 'auth.json.enc';
const WHAT = 'the Codex sign-in';

/** Vaults by the accounts folder they own, so readAuth/writeAuth (records.cjs) find the one for a home. */
const vaults = new Map();

class AuthVault {
  /** @param {{ root: string, safeStorage: SafeStorage | null }} o */
  constructor({ root, safeStorage }) {
    this.root = path.resolve(root);
    this.safe = safeStorage;
    /** home -> the decrypted text and the sealed file it came from (mtime and size) */
    this.cache = new Map();
    /** homes whose sealed sign-in could not be decrypted at the last read (the Keychain refused, another key) */
    this.refused = new Set();
    vaults.set(this.root, this);
  }

  /** A vault for `root` with what is there sealed (sealAll): what the account manager opens at startup. */
  static start(/** @type {{ root: string, safeStorage: SafeStorage | null }} */ o) {
    const vault = new AuthVault(o);
    vault.sealAll();
    return vault;
  }

  /** The vault that owns `home` (an added account's folder or a sign-in in progress), or null for any other home. */
  static of(/** @type {string} */ home) {
    return vaults.get(path.dirname(path.resolve(home))) ?? null;
  }

  /** Whether `home` is one of its accounts' folders (never the CLI's own $CODEX_HOME). */
  owns(/** @type {string} */ home) {
    return path.dirname(path.resolve(home)) === this.root;
  }

  /** Whether `home`'s sign-in is there but could not be decrypted at the last read: the user is told so, not that it expired. */
  unreadable(/** @type {string} */ home) {
    return this.refused.has(home);
  }

  /** Whether sign-ins can be kept here (safeStorage has its key). */
  available() {
    return canEncrypt(this.safe);
  }

  /**
   * The sign-in's JSON text: the plain file while a helper runs (it is the newest: the helper may just have refreshed
   * it), else the sealed one decrypted; null when there is none or it can't be read (recorded).
   * @param {string} home
   */
  read(home) {
    try {
      return fs.readFileSync(path.join(home, PLAIN), 'utf8');
    } catch (error) {
      // no plain file (ENOENT): the sealed one is read below
      noteIgnored('read a Codex sign-in', error, ['ENOENT']);
    }
    const file = path.join(home, SEALED);
    try {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (!st) {
        this.refused.delete(home);
        return null;
      }
      const hit = this.cache.get(home);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
      // the file is there (stat above); one deleted meanwhile throws below like any unreadable one
      const text = /** @type {{ value: string }} */ (readSecret(file, this.safe)).value;
      this.cache.set(home, { mtimeMs: st.mtimeMs, size: st.size, text });
      this.refused.delete(home);
      return text;
    } catch (error) {
      // saved under another OS key, or unreadable: not signed in, and recorded
      noteIgnored('decrypt a Codex sign-in', error);
      this.refused.add(home);
      return null;
    }
  }

  /**
   * Saves a sign-in encrypted; throws SecretUnavailableError (nothing written) without the OS key. A plain copy a
   * running helper reads is replaced too, so it sees the new sign-in.
   * @param {string} home @param {string | Buffer} text
   */
  write(home, text) {
    const value = String(text);
    writeSecret(path.join(home, SEALED), value, this.safe, WHAT);
    this.cache.delete(home);
    if (fs.existsSync(path.join(home, PLAIN))) writePrivate(path.join(home, PLAIN), value);
  }

  /** Before a helper starts in `home`: the sign-in it reads, written from the sealed copy (0600). */
  open(/** @type {string} */ home) {
    if (!this.owns(home) || fs.existsSync(path.join(home, PLAIN))) return;
    const text = this.read(home);
    if (text != null) writePrivate(path.join(home, PLAIN), text);
  }

  /**
   * The running helper (sidecar) for `home` in `helpers`, or one `start` makes with the plain sign-in opened for it and
   * sealed again when it exits (unless another has taken its place by then).
   * @template {{ running: boolean }} H
   * @param {Map<string, H>} helpers @param {string} home @param {(onExit: () => void) => H} start
   * @returns {H}
   */
  helper(helpers, home, start) {
    const running = helpers.get(home);
    if (running?.running) return running;
    this.open(home);
    const helper = start(() => {
      if (helpers.get(home) === helper) helpers.delete(home);
      if (!helpers.get(home)?.running) this.seal(home);
    });
    helpers.set(home, helper);
    return helper;
  }

  /**
   * After the helper in `home` exits: what it left in auth.json (a refreshed token) is encrypted and the plain file
   * deleted. Without the OS key the plain file stays (deleting it would lose the sign-in) and the next seal retries.
   * @param {string} home
   */
  seal(home) {
    if (!this.owns(home)) return;
    const plain = path.join(home, PLAIN);
    let text;
    try {
      text = fs.readFileSync(plain, 'utf8');
    } catch (error) {
      // nothing left in plain text (ENOENT)
      noteIgnored('read a Codex sign-in to encrypt it', error, ['ENOENT']);
      return;
    }
    try {
      writeSecret(path.join(home, SEALED), text, this.safe, WHAT);
      this.cache.delete(home);
      fs.rmSync(plain, { force: true });
    } catch (error) {
      // kept in plain text until a later seal can encrypt it
      noteIgnored('encrypt a Codex sign-in', error);
    }
  }

  /** Temporary files a write that never finished left in `home` (fsutil's .mopilot-*.tmp): one may hold a sign-in. */
  #dropTemporaries(/** @type {string} */ home) {
    try {
      for (const name of fs.readdirSync(home)) if (/^\.mopilot-.*\.tmp$/.test(name)) fs.rmSync(path.join(home, name), { force: true });
    } catch (error) {
      // tried again at the next start
      noteIgnored('remove what an unfinished write left in a Codex account folder', error);
    }
  }

  /**
   * At startup: every account's plain sign-in sealed (an earlier version kept them all in plain text, a crash can
   * leave one), and sign-ins an earlier run never finished deleted with what they hold. At quit, after the sidecars
   * were told to stop: quitting does not wait for them to exit, so what they leave is sealed here.
   */
  sealAll() {
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (error) {
      // no accounts folder yet (ENOENT): nothing to seal
      noteIgnored('list the Codex account folders', error, ['ENOENT']);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const home = path.join(this.root, e.name);
      if (!e.name.startsWith('.signin-')) {
        if (!e.name.startsWith('.')) {
          this.seal(home);
          this.#dropTemporaries(home);
        }
        continue;
      }
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch (error) {
        // tried again at the next start
        noteIgnored('remove an unfinished Codex sign-in', error);
      }
    }
  }
}

module.exports = { AuthVault, PLAIN, SEALED };
