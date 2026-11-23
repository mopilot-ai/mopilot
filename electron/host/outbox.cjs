// The persistent outbox for messages sent to a Host that may be offline: one file per chat, written before the wire, changed one key at a time, acked only by the Host's own record of the input.
const crypto = require('node:crypto');
const path = require('node:path');
const { readStoreFile, writeAtomic } = require('../platform/fsutil.cjs');
const { syncFolder } = require('../platform/folderSync.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const { isJsonRecord: isObject } = require('../../shared/jsonRecord.mjs');

const VERSION = 1;
/** A sent message the Host has not recorded after this long is reported to the user (it is never sent again under a new key). */
const STALLED_MS = 60_000;
const STATES = new Set(['queued', 'sent']);
const FILE = /^[0-9a-f]{64}\.json$/;

/**
 * @typedef {{ key: string, chatId: string, epoch: number, options: unknown, state: 'queued' | 'sent', queuedAt: number, sentAt: number | null }} OutboxEntry
 */

/** What the composer shows on a queued bubble while the Host registry says the machine is not usable; null when it is. @param {{ status?: string } | null | undefined} row */
const waitingFor = (row) => (row && row.status === 'online' ? null : 'host');

/** @param {unknown} e @param {string} chatId */
const validEntry = (e, chatId) =>
  isObject(e) &&
  typeof e.key === 'string' &&
  e.key !== '' &&
  e.chatId === chatId &&
  Number.isSafeInteger(e.epoch) &&
  /** @type {number} */ (e.epoch) >= 0 &&
  STATES.has(/** @type {string} */ (e.state)) &&
  Number.isFinite(e.queuedAt);

/**
 * @param {object} o
 * @param {string} o.dir where the per-chat files live (the user data dir)
 * @param {(error: Error) => void} [o.report] where an outbox file that could not be read or written is reported
 */
function createOutbox({ dir, report }) {
  /** Last good entries per chat: a file that turns unreadable later keeps serving these and is never overwritten. @type {Map<string, OutboxEntry[]>} */
  const known = new Map();
  /** Chats whose file could not be read at the last look: reads serve what was known, writes are refused so the damaged file is kept. @type {Set<string>} */
  const damaged = new Set();
  /** Chats with a drain in flight: a second call joins it instead of sending the same entries twice. @type {Map<string, Promise<any>>} */
  const draining = new Map();
  let disposed = false;

  /** Chat ids are opaque, so the file is named by a hash of the id. @param {string} chatId */
  const fileOf = (chatId) => path.join(dir, `${crypto.createHash('sha256').update(chatId).digest('hex')}.json`);

  /** @param {string} chatId @returns {OutboxEntry[]} */
  function load(chatId) {
    const { data, error } = readStoreFile(
      fileOf(chatId),
      'the Host outbox',
      (d) => isObject(d) && d.chatId === chatId && Array.isArray(d.entries) && d.entries.every((e) => validEntry(e, chatId)),
    );
    if (error) {
      damaged.add(chatId);
      report?.(error);
      const prior = known.get(chatId);
      if (prior) return prior;
      throw Object.assign(new Error('The saved outbox for this chat could not be read.'), { code: 'outbox_unreadable' });
    }
    damaged.delete(chatId);
    const entries = data ? data.entries : [];
    // nothing waits: nothing is kept for the chat
    if (entries.length) known.set(chatId, entries);
    else known.delete(chatId);
    return entries;
  }

  /** Write `entries` as the chat's outbox; the last ack deletes the file. On a failed write nothing changes and the error goes to the caller. @param {string} chatId @param {OutboxEntry[]} entries */
  function save(chatId, entries) {
    if (entries.length) {
      writeAtomic(fileOf(chatId), `${JSON.stringify({ version: VERSION, chatId, entries })}\n`);
      known.set(chatId, entries);
    } else {
      fs.rmSync(fileOf(chatId), { force: true });
      known.delete(chatId);
    }
  }

  /** Read the file again, apply one change to the current entries, write: another window's entry for another key is never lost. @param {string} chatId @param {(entries: OutboxEntry[]) => OutboxEntry[] | null} change */
  function edit(chatId, change) {
    const current = load(chatId).map((e) => ({ ...e }));
    if (damaged.has(chatId))
      throw Object.assign(new Error('The saved outbox for this chat could not be read.'), { code: 'outbox_unreadable' });
    const next = change(current);
    if (next) save(chatId, next);
    return next !== null;
  }

  /** @param {string} chatId @param {string} key @param {(e: OutboxEntry) => void} fn */
  const touch = (chatId, key, fn) =>
    edit(chatId, (entries) => {
      const e = entries.find((x) => x.key === key);
      if (!e) return null;
      fn(e);
      return entries;
    });

  return {
    /**
     * Keep a message before it goes anywhere. The same key twice is the same message. Throws (keeping nothing) when the write fails, so the caller still holds the text.
     * @param {string} chatId @param {{ key: string, epoch: number, options: unknown }} item
     */
    add(chatId, { key, epoch, options }) {
      if (typeof key !== 'string' || !key || !Number.isSafeInteger(epoch) || epoch < 0)
        throw new Error('A queued message needs a key and an owner epoch.');
      edit(chatId, (entries) =>
        entries.some((e) => e.key === key)
          ? null
          : [...entries, { key, chatId, epoch, options, state: 'queued', queuedAt: clock.now(), sentAt: null }],
      );
    },
    /** The user deleted a queued bubble. A message already sent cannot be taken back: returns false and leaves it. @param {string} chatId @param {string} key */
    remove(chatId, key) {
      let removed = false;
      edit(chatId, (entries) => {
        const e = entries.find((x) => x.key === key);
        if (!e || e.state !== 'queued') return null;
        removed = true;
        return entries.filter((x) => x !== e);
      });
      return removed;
    },
    /** The chats with a message still kept, from the files on disk (a restart finds its work here). A file that cannot be read is reported and skipped. */
    chats() {
      /** @type {string[]} */
      const ids = [];
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        if (/** @type {any} */ (error)?.code === 'ENOENT') return ids;
        throw error;
      }
      for (const name of names.filter((n) => FILE.test(n))) {
        const { data, error } = readStoreFile(
          path.join(dir, name),
          'the Host outbox',
          (d) => isObject(d) && typeof d.chatId === 'string' && Array.isArray(d.entries),
        );
        if (error) report?.(error);
        else if (data && data.entries.length && fileOf(data.chatId) === path.join(dir, name)) ids.push(data.chatId);
      }
      return ids;
    },
    /** What still waits, in send order. @param {string} chatId */
    pending: (chatId) => load(chatId).map((e) => ({ ...e })),
    /** The Host has these inputs on record (its Hello's `inputKeys`, or a `UserInput` item in the stream): they are done. Unknown keys are ignored. @param {string} chatId @param {string[]} keys */
    /** Chat deletion retires even already-sent inputs and fsyncs the unlink before remote deletion can be acknowledged. */
    retire(chatId) {
      const keys = load(chatId).map((entry) => entry.key);
      edit(chatId, () => []);
      if (fs.existsSync(dir)) syncFolder(dir, { fs });
      return keys;
    },
    ack(chatId, keys) {
      const done = new Set(keys);
      edit(chatId, (entries) => (entries.some((e) => done.has(e.key)) ? entries.filter((e) => !done.has(e.key)) : null));
    },
    /** The continue dialog was accepted: queued messages are owned by the new epoch and can drain. `only` limits it to the entries it accepts. @param {string} chatId @param {number} epoch @param {(e: OutboxEntry) => boolean} [only] */
    rebase(chatId, epoch, only = () => true) {
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('An owner epoch is required.');
      edit(chatId, (entries) => {
        const queued = entries.filter((e) => e.state === 'queued' && e.epoch !== epoch && only(e));
        for (const e of queued) e.epoch = epoch;
        return queued.length ? entries : null;
      });
    },
    /** Notes something on a kept message's options (it was handed to this Mac's controller and not yet acked); false when it is gone. @param {string} chatId @param {string} key @param {Record<string, unknown>} patch */
    annotate: (chatId, key, patch) =>
      touch(chatId, key, (e) => {
        e.options = { .../** @type {any} */ (e.options), ...patch };
      }),
    /** Sent messages the user chose to try again (the Host never recorded them): they go back to queued under the same key, so the Host's dedupe keeps it one input. @param {string} chatId @param {string[]} keys */
    requeue(chatId, keys) {
      const again = new Set(keys);
      edit(chatId, (entries) => {
        const sent = entries.filter((e) => e.state === 'sent' && again.has(e.key));
        for (const e of sent) {
          e.state = 'queued';
          e.sentAt = null;
        }
        return sent.length ? entries : null;
      });
    },
    /** Sent messages the Host has not recorded for `afterMs`: the user is told; none is sent again under a new key. @param {string} chatId @param {number} [afterMs] */
    stalled(chatId, afterMs = STALLED_MS) {
      const now = clock.now();
      return load(chatId)
        .filter((e) => e.state === 'sent' && e.sentAt !== null && now - e.sentAt >= afterMs)
        .map((e) => e.key);
    },
    /**
     * Send the queued messages in order. One drain per chat at a time. Stops at the first refusal or failure, keeping that message and everything behind it.
     * @param {string} chatId
     * @param {object} o
     * @param {() => boolean} o.online the Host is usable now (checked again before every message)
     * @param {(entry: OutboxEntry) => Promise<void>} o.send delivers one message under its own key; rejects with `code: 'stale_epoch'` when the Host has a newer owner
     * @param {(entry: OutboxEntry) => void} [o.onStale] the continue dialog opens instead of the message being dropped
     * @returns {Promise<{ sent: number, stopped: null | 'offline' | 'stale_epoch' | 'failed', error?: Error }>}
     */
    drain(chatId, { online, send, onStale = () => undefined }) {
      const running = draining.get(chatId);
      if (running) return running;
      const run = (async () => {
        let sent = 0;
        // read again before every message: one added, deleted or acked while an earlier message was in flight is seen
        for (let entry = load(chatId).find((e) => e.state === 'queued'); entry; entry = load(chatId).find((e) => e.state === 'queued')) {
          if (disposed || !online()) return { sent, stopped: /** @type {const} */ ('offline') };
          try {
            await send(entry);
          } catch (error) {
            if (/** @type {any} */ (error)?.code === 'stale_epoch') {
              onStale(entry);
              return { sent, stopped: /** @type {const} */ ('stale_epoch'), error: /** @type {Error} */ (error) };
            }
            return { sent, stopped: /** @type {const} */ ('failed'), error: /** @type {Error} */ (error) };
          }
          sent++;
          try {
            touch(chatId, entry.key, (e) => {
              e.state = 'sent';
              e.sentAt = clock.now();
            });
          } catch (error) {
            // still queued on disk: the next drain sends the same key again and the Host's dedupe makes it one input
            report?.(/** @type {Error} */ (error));
            return { sent, stopped: /** @type {const} */ ('failed'), error: /** @type {Error} */ (error) };
          }
        }
        return { sent, stopped: null };
      })().finally(() => {
        if (draining.get(chatId) === run) draining.delete(chatId);
      });
      draining.set(chatId, run);
      return run;
    },
    dispose() {
      disposed = true;
    },
  };
}

module.exports = { createOutbox, waitingFor, STALLED_MS };
