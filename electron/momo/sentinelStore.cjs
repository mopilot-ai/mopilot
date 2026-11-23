// Where MoMo's sentinel keeps remembered approvals (#2139): one file per MoPilot data folder (production <userData>/momo/approvals.bin, folder 0700, file 0600) encrypted with Electron safeStorage and written whole (temp, sync, rename, folder sync), held by one owner at a time through a lock file. Without encryption nothing is read or written; a file that can't be decrypted or parsed is reported and left as it is (the Keychain may only be locked for now), never read as empty, until the user sets it aside.
const { fs: fsPort } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { encryptForStore, canEncrypt } = require('../platform/encryptedStore.cjs');
const { writeDurable } = require('../gateway/durableWrite.cjs');
const { acquireLock } = require('../gateway/fileLock.cjs');

/**
 * @param {{ file: string, safeStorage: import('./auditKey.cjs').SafeStorage | null, fs?: typeof fsPort.promises, now?: () => number,
 *           lock?: { pid?: number, isAlive?: (pid: number) => boolean } }} o lock: who holds the folder (tests)
 * @returns {import('./sentinel.cjs').Storage & { close(): Promise<void> }}
 */
function sentinelFileStorage({ file, safeStorage, fs = fsPort.promises, now = Date.now, lock = {} }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('remembered approvals need an absolute file');
  const dir = path.dirname(file);
  const unavailable = () =>
    Object.assign(new Error('remembered approvals need encryption, which this Mac cannot offer now'), { code: 'unavailable' });
  const available = () => {
    return canEncrypt(safeStorage);
  };
  /** @type {Promise<{ release(): Promise<void> }> | null} */
  let held = null;
  /** Holds the folder for this store's lifetime: a second writer would undo a revoke or a deny always. */
  const locked = () => {
    if (!held) {
      held = (async () => {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.chmod(dir, 0o700);
        return acquireLock({ fs, file: `${file}.lock`, ...lock });
      })();
      held.catch(() => {
        held = null;
      });
    }
    return held;
  };
  return {
    async read() {
      if (!available()) throw unavailable();
      await locked();
      let sealed;
      try {
        sealed = await fs.readFile(file, 'utf8');
      } catch (e) {
        if (/** @type {any} */ (e)?.code === 'ENOENT') return null;
        throw e;
      }
      try {
        return JSON.parse(/** @type {NonNullable<typeof safeStorage>} */ (safeStorage).decryptString(Buffer.from(sealed.trim(), 'base64')));
      } catch {
        // left as it is: a locked Keychain may open it later, and it is the only copy of every deny always
        throw Object.assign(new Error('remembered approvals could not be read'), { code: 'unreadable' });
      }
    },
    async write(data) {
      const enc = encryptForStore(safeStorage, JSON.stringify(data));
      if (!enc.ok) throw unavailable();
      await locked();
      await writeDurable(fs, file, `${enc.value}\n`);
    },
    /** The user's choice for a file that stays unreadable: it is kept aside, and the approvals start empty. */
    async setAside() {
      await locked();
      const keptAs = `${file}.unreadable-${now()}`;
      try {
        await fs.rename(file, keptAs);
      } catch (e) {
        if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
      }
      return keptAs;
    },
    async close() {
      const h = held;
      held = null;
      if (h !== null) await (await h).release();
    },
  };
}

module.exports = { sentinelFileStorage };
