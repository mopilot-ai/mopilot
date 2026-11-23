// The acting calls a Host has sent out and not heard back from, on disk before each is sent: a tool call relayed to the app, an action on the Host's desktop, an input or navigation in its browser. The next Host on the data folder finds the ones a dead Host left and settles them as lost in the turn they belonged to (./chatLog.mjs recoverTurn); nothing here sends one again.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// a folder is synced where the system can (electron/platform/folderSync.cjs); a Host runs on Linux and macOS
const { syncFolder } = createRequire(import.meta.url)('../../electron/platform/folderSync.cjs');

/** How many lost calls one turn's end names. */
const NAMED = 5;
const lostFile = (/** @type {string} */ dataDir) => path.join(dataDir, 'calls-lost.json');

/** How long a browser input stays recorded after it was answered: a burst (typing, a drag) is one record, not a write per event. */
const LINGER_MS = 2000;

/**
 * @typedef {{ chatId: string, kind: 'tool' | 'desktop' | 'browser', name: string }} Call
 * @typedef {Call & { turnId: string }} Lost a call the last Host left, with the turn whose end names it
 */

/** @param {unknown} v @returns {v is Call} */
const isCall = (v) =>
  typeof v === 'object' &&
  v !== null &&
  typeof (/** @type {any} */ (v).chatId) === 'string' &&
  ['tool', 'desktop', 'browser'].includes(/** @type {any} */ (v).kind) &&
  typeof (/** @type {any} */ (v).name) === 'string';
const keyOf = (/** @type {Call} */ c) => `${c.chatId}\n${c.kind}\n${c.name}`;

/**
 * The calls a file holds; none when it is missing. A file that is there and cannot be read is reported: what it held is not known.
 * @param {typeof fs} io @param {string} file @param {(message: string) => void} report @returns {any[]}
 */
function read(io, file, report) {
  try {
    return Object.values(JSON.parse(io.readFileSync(file, 'utf8'))).filter(isCall);
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') report(`${path.basename(file)} could not be read, so the calls it held are not known.`);
    return [];
  }
}

/** @param {typeof fs} io @param {string} file a file to sync (a folder: syncFolder) */
function sync(io, file) {
  const fd = io.openSync(file, 'r');
  try {
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

/** Replaces the file whole. `synced` is for a record that must outlive the machine going down, not only this process. */
function write(/** @type {typeof fs} */ io, /** @type {string} */ file, /** @type {object} */ value, /** @type {boolean} */ synced) {
  io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  io.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  if (synced) sync(io, tmp);
  io.renameSync(tmp, file);
  if (synced) syncFolder(path.dirname(file), { fs: io });
}

/**
 * @param {object} o
 * @param {string} o.dataDir @param {typeof fs} [o.io]
 * @param {(message: string) => void} [o.report] hears of a record that could not be written: the call still runs (a full disk must not stop every
 *   tool), and that one call is then not known to the next Host
 * @param {typeof setTimeout} [o.setTimer] the timer that clears an answered browser input, replaceable so a test decides when it fires
 */
export function createCallIntents({ dataDir, io = fs, report = () => undefined, setTimer = setTimeout }) {
  const file = path.join(dataDir, 'calls.json');
  /** The calls under way by the id they were begun with. @type {Map<string, Call>} */
  const open = new Map();
  /** What the file should hold: one record for the same call of a chat however many are under way, with how many are. @type {Map<string, { call: Call, n: number }>} */
  const records = new Map();
  /** Whether the file holds `records` as they are now: a write that failed is tried again with the next one. */
  let current = true;
  /** Nothing is written before the last Host's calls were read: this Host may not hold the data folder yet. */
  let armed = false;
  const save = (/** @type {boolean} */ synced) => {
    try {
      write(
        io,
        file,
        [...records.values()].map((r) => r.call),
        synced,
      );
      current = true;
    } catch (e) {
      current = false;
      report(`calls.json: ${/** @type {Error} */ (e).message}`);
    }
  };
  /** The record goes once nothing of its kind is under way (a linger that a new call of the same kind overtook leaves it). @param {string} key */
  const clear = (key) => {
    if (records.get(key)?.n !== 0) return;
    records.delete(key);
    // not synced: an end that a power cut loses is told as lost, which errs on the side of looking again
    save(false);
  };
  return {
    /** A call is about to be sent: it is on disk when this returns. @param {string} id @param {Call} call */
    begin(id, call) {
      if (!armed) return;
      open.set(id, call);
      const key = keyOf(call);
      const record = records.get(key);
      if (record) record.n++;
      else records.set(key, { call, n: 1 });
      if (!record || !current) save(true);
    },
    /** The call was answered, refused, stopped or timed out: its outcome is known to the turn. @param {string} id */
    end(id) {
      const call = open.get(id);
      if (!call) return;
      open.delete(id);
      const key = keyOf(call);
      /** @type {{ n: number }} */ (records.get(key)).n--;
      if (call.kind === 'browser') setTimer(() => clear(key), LINGER_MS).unref?.();
      else clear(key);
    },
    /**
     * The calls the last Host left unanswered, kept for the turns that are about to be ended, and from here on this Host's are recorded. Call it
     * once, after this Host holds the data folder. A call of a chat with no turn to end has nowhere to be told and is dropped, with a report.
     * @param {[turnId: string, chatId: string][]} left the turns the last Host left running
     * @returns {Lost[]}
     */
    start(left) {
      const turnOf = new Map(left.map(([turnId, chatId]) => [chatId, turnId]));
      const waiting = new Set(left.map(([turnId]) => turnId));
      // the ones an earlier start kept for a turn that could not be ended then (a turn that has ended since takes its calls with it), and the
      // ones the last Host left, which belong to the turn its chat was running
      const before = read(io, lostFile(dataDir), report).filter((c) => waiting.has(c.turnId) && turnOf.get(c.chatId) === c.turnId);
      const found = read(io, file, report);
      const mine = found
        .filter((c) => turnOf.has(c.chatId))
        .map((c) => ({ chatId: c.chatId, kind: c.kind, name: c.name, turnId: turnOf.get(c.chatId) }));
      if (mine.length < found.length) report(`Dropped ${found.length - mine.length} unanswered call(s) of chats with no turn to end.`);
      const kept = /** @type {Lost[]} */ ([...before, ...mine]);
      armed = true;
      try {
        // the lost ones first: a Host that dies between the two writes finds them twice, never not at all
        write(io, lostFile(dataDir), kept, true);
      } catch (e) {
        // what the last Host left stays where it is until a write of this Host's own replaces it: the next start still finds it
        current = false;
        report(`calls-lost.json: ${/** @type {Error} */ (e).message}`);
        return kept;
      }
      save(true);
      return kept;
    },
  };
}

/**
 * The calls a restart lost for a turn, each kind and name once, oldest first (at most five).
 * @param {string} dataDir @param {string} chatId @param {string} turnId @param {typeof fs} [io]
 * @returns {{ kind: Call['kind'], name: string }[]}
 */
export function lostCalls(dataDir, chatId, turnId, io = fs) {
  /** @type {Map<string, { kind: Call['kind'], name: string }>} */
  const named = new Map();
  for (const c of read(io, lostFile(dataDir), () => undefined))
    if (c.chatId === chatId && c.turnId === turnId) named.set(`${c.kind} ${c.name}`, { kind: c.kind, name: c.name });
  return [...named.values()].slice(0, NAMED);
}

/**
 * Runs one call with its record around it; a read (`call` null) and a Host without records run it bare.
 * @template T
 * @param {Pick<ReturnType<typeof createCallIntents>, 'begin' | 'end'> | undefined} intents @param {Call | null} call @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function tracked(intents, call, run) {
  if (!intents || !call) return run();
  const id = randomUUID();
  intents.begin(id, call);
  try {
    return await run();
  } finally {
    intents.end(id);
  }
}
