// The messages a Host holds for a chat behind its running turn, on disk: one private file per chat, replaced whole and synced, so the next Host on the data folder finds what the last one had accepted and not yet started.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// a folder is synced where the system can (electron/platform/folderSync.cjs); a Host runs on Linux and macOS
const { syncFolder } = createRequire(import.meta.url)('../../electron/platform/folderSync.cjs');

const FILE = /^[a-f0-9]{64}\.json$/;
const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {typeof fs} io @param {string} file a file to sync (a folder: syncFolder) */
function sync(io, file) {
  const fd = io.openSync(file, 'r');
  try {
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

/**
 * @typedef {{ chatId: string, items: { id: string, text: string, attachments?: unknown[], opts?: object }[], users?: Record<string, object>, pendingSwitch?: unknown }} QueueRecord
 * A chat's record also keeps the choice of another agent the person made and nothing has settled (it may carry the credential they chose, so it is as private as the file is): a record with only that has no items.
 * @param {{ dir: string, io?: typeof fs, report: (message: string) => void }} o `dir` holds the files; `report` hears of one that cannot be read (it is kept)
 */
export function createQueueStore({ dir, io = fs, report }) {
  const fileOf = (/** @type {string} */ chatId) => path.join(dir, `${createHash('sha256').update(chatId).digest('hex')}.json`);
  /** The chats that have a file, so a chat with nothing waiting costs no file call. @type {Set<string>} */
  const kept = new Set();
  return {
    /**
     * Replaces what waits for the chat; `null`, or no items and no held choice, removes its file. The record is on disk when this returns.
     * @param {string} chatId @param {QueueRecord | null} record
     */
    put(chatId, record) {
      const file = fileOf(chatId);
      if (!record?.items.length && !record?.pendingSwitch) {
        if (!kept.has(chatId)) return;
        io.rmSync(file, { force: true });
        // forgotten only once it is gone: a removal that failed is tried again by the next one
        kept.delete(chatId);
        return void syncFolder(dir, { fs: io });
      }
      io.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      io.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      sync(io, tmp);
      io.renameSync(tmp, file);
      // known from the rename on: a folder sync that fails must not leave a file nothing removes
      kept.add(chatId);
      syncFolder(dir, { fs: io });
    },
    /** Every chat's waiting messages as the last Host left them; a file that cannot be read is reported and left where it is. @returns {QueueRecord[]} */
    all() {
      /** @type {string[]} */
      let names;
      try {
        names = io.readdirSync(dir);
      } catch (error) {
        if (/** @type {any} */ (error).code === 'ENOENT') return [];
        throw error;
      }
      /** @type {QueueRecord[]} */
      const records = [];
      // a write the last Host did not finish: its record never replaced the one before it
      for (const name of names.filter((n) => n.endsWith('.tmp'))) io.rmSync(path.join(dir, name), { force: true });
      for (const name of names.filter((n) => FILE.test(n))) {
        try {
          const record = JSON.parse(io.readFileSync(path.join(dir, name), 'utf8'));
          const valid =
            isObject(record) &&
            typeof record.chatId === 'string' &&
            fileOf(record.chatId) === path.join(dir, name) &&
            Array.isArray(record.items) &&
            record.items.every((/** @type {any} */ i) => isObject(i) && typeof i.id === 'string' && typeof i.text === 'string');
          if (!valid) throw new Error('not a queue record');
          kept.add(record.chatId);
          records.push(record);
        } catch {
          report(`A chat's waiting messages could not be read and were kept: ${path.join(dir, name)}`);
        }
      }
      return records;
    },
  };
}
