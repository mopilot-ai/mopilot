// Durable remote chat deletions bind one paired machine and client identity; corrupt jobs are preserved while healthy jobs can still settle.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic } = require('../platform/fsutil.cjs');
const { syncFolder } = require('../platform/folderSync.cjs');
const HEX = /^[a-f0-9]{64}$/;
const FILE = /^[a-f0-9]{64}\.json$/;
function createDeletionOutbox({
  dir,
  identity,
  hostFor,
  rowOf,
  enabled = () => true,
  beforeDelete = /** @type {(chatId: string) => void} */ ((_chatId) => undefined),
  report = /** @type {(error: Error) => void} */ ((_error) => undefined),
}) {
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const idOf = (row) => hash(JSON.stringify([row.hostId, row.identity, row.chatId]));
  const folder = (hostId) => path.join(dir, hash(hostId));
  const fileOf = (row) => path.join(folder(row.hostId), `${idOf(row)}.json`);
  const bad = () => new Error('A pending machine chat deletion cannot be read. Its file has been preserved.');
  const sync = (file, directory = false) => {
    if (directory) return syncFolder(file, { fs });
    const fd = fs.openSync(file, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const names = (at) => {
    try {
      return fs.readdirSync(at);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const load = (file) => {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !row ||
      typeof row.hostId !== 'string' ||
      typeof row.identity !== 'string' ||
      typeof row.chatId !== 'string' ||
      typeof row.key !== 'string' ||
      !Number.isSafeInteger(row.epoch) ||
      row.epoch < 0 ||
      fileOf(row) !== file
    )
      throw bad();
    return row;
  };
  /** Every readable job; an unreadable file or machine folder is reported and kept where it is. */
  const rows = () => {
    const result = [];
    for (const machine of names(dir).filter((name) => HEX.test(name))) {
      try {
        for (const name of names(path.join(dir, machine)).filter((name) => FILE.test(name))) {
          try {
            result.push(load(path.join(dir, machine, name)));
          } catch {
            report(bad());
          }
        }
      } catch {
        report(bad());
      }
    }
    return result;
  };
  const forget = (row) => {
    fs.unlinkSync(fileOf(row));
    sync(folder(row.hostId), true);
  };
  /** @type {Promise<void> | null} */
  let running = null;
  return {
    /** The jobs that can be read; an unreadable one is reported and kept, so the list still shows the rest. */
    pending: () => rows(),
    /** Whether this app's identity already has a job for the chat on that machine. */
    queued: (hostId, chatId) => {
      const client = identity();
      return !!client && fs.statSync(fileOf({ hostId, chatId, identity: client }), { throwIfNoEntry: false }) !== undefined;
    },
    /** Takes back a job whose local deletion did not go through: the chat is still here, so its machine copy must stay. */
    cancel: (row) => forget(row),
    has: (row) => fs.statSync(fileOf(row), { throwIfNoEntry: false }) !== undefined,
    /** Whether the machine's Host has answered a hello without `journalLifecycle` (so it is too old to take a deletion): one not heard from yet, or whose connection dropped, only waits to be reached. */
    outdated: (hostId) => {
      const host = hostFor(hostId);
      return rowOf(hostId)?.status === 'online' && host?.negotiated?.() === true && host.speaks?.('journalLifecycle') === false;
    },
    enqueue({ hostId, chatId, epoch }) {
      const client = identity();
      if (!client) throw new Error('This app has no paired identity for the deletion.');
      const wanted = { hostId, chatId, epoch, identity: client, key: crypto.randomUUID() };
      const file = fileOf(wanted);
      let existing;
      try {
        existing = load(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw bad();
      }
      const row = existing ?? wanted;
      fs.mkdirSync(folder(hostId), { recursive: true, mode: 0o700 });
      sync(path.dirname(dir), true);
      sync(dir, true);
      if (!existing) writeAtomic(file, JSON.stringify(row), undefined, 0o600);
      // Retry fsyncs existing rows too: a prior directory-sync failure is not a durable admission.
      sync(file);
      sync(folder(hostId), true);
      return row;
    },
    flush() {
      if (running !== null) return running;
      running = (async () => {
        // A store that cannot be listed at all is reported, never thrown: a reconnect notification has nobody to catch it.
        let jobs;
        try {
          jobs = rows();
        } catch (error) {
          return void report(error);
        }
        for (const row of jobs) {
          try {
            if (!enabled() || identity() !== row.identity) continue;
            beforeDelete(row.chatId);
            if (rowOf(row.hostId)?.status !== 'online' || !enabled()) continue;
            const host = hostFor(row.hostId);
            if (!host?.speaks?.('journalLifecycle') || !host.removeChat) continue;
            const result = await host.removeChat(row.chatId, { epoch: row.epoch, key: row.key });
            if (result?.removed === true) forget(row);
          } catch (error) {
            report(error);
          }
        }
      })().finally(() => {
        running = null;
      });
      return running;
    },
    /** Removing a machine cancels even unreadable jobs, without keeping SSH records or obtaining a connection. */
    dropMachine(hostId) {
      fs.rmSync(folder(hostId), { recursive: true, force: true });
      if (fs.existsSync(dir)) sync(dir, true);
    },
  };
}
module.exports = { createDeletionOutbox };
