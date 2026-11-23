// Pending turn markers survive a Host crash and remain until each chat's terminal durable commits; one bad chat never clears another's recovery.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// a folder is synced where the system can (electron/platform/folderSync.cjs); a Host runs on Linux and macOS
const { syncFolder } = createRequire(import.meta.url)('../../electron/platform/folderSync.cjs');

/**
 * @param {{ dataDir: string, report?: (message: string) => void }} o
 */
export function createRunJournal({ dataDir, report = () => undefined }) {
  const file = path.join(dataDir, 'running.json');
  /** turn id -> chat id @type {Map<string, string>} */
  const running = new Map();
  /** Nothing is written before the previous run's turns were read: this Host may not hold the lock yet. */
  let armed = false;

  function write() {
    if (!armed) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(Object.fromEntries(running)));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      syncFolder(dataDir, { fs });
    } catch (e) {
      report(`running.json: ${/** @type {Error} */ (e).message}`);
      throw e;
    }
  }

  return {
    /** A turn started. @param {string} turnId @param {string} chatId */
    begin(turnId, chatId) {
      running.set(turnId, chatId);
      write();
    },
    /** A turn ended (however it did). @param {string} turnId */
    end(turnId) {
      const chatId = running.get(turnId);
      if (chatId !== undefined) {
        running.delete(turnId);
        try {
          write();
        } catch (error) {
          running.set(turnId, chatId);
          throw error;
        }
      }
    },
    /** The turns recorded as running now (the Host's own, this run): what a stop ends before it ends the children. @returns {[turnId: string, chatId: string][]} */
    pending: () => [...running],
    /**
     * The turns the previous run left running, and from here on this run's are recorded. Call it once, after this Host holds the data dir's lock.
     * @returns {[turnId: string, chatId: string][]}
     */
    start() {
      /** @type {[string, string][]} */
      let left = [];
      try {
        left = Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))).filter(([, chatId]) => typeof chatId === 'string');
      } catch {
        // none recorded, or a damaged file: nothing is known to be running
      }
      for (const [turnId, chatId] of left) running.set(turnId, chatId);
      armed = true;
      try {
        write();
      } catch {
        /* write() reported; keep markers and permit healthy reads/recovery. */
      }
      return left;
    },
  };
}
