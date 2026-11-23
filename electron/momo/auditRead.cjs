// Reading MoMo's audit log back (#2139): the chain check verify() runs file by file (each entry's HMAC, number and link, a cut line, the oldest files rotation removed and recorded, the sealed checkpoint of the last entry), and the scan for intents a quit left without an outcome, which counts only entries the log's own key signed.
const { macMatches } = require('./auditKey.cjs');

/** The `prev` of the first entry ever written. */
const GENESIS = '0'.repeat(64);

const isRecord = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Whether the log's end reaches the checkpoint: the checkpoint is at most one entry behind it (a crash between an entry and
 * its checkpoint), never ahead. A missing checkpoint is only possible right after the very first entry.
 * @param {{ seq: number, mac: string } | null} cp
 * @param {Map<number, string>} macs the HMAC of each entry still in the log, by number
 * @param {number} last
 */
function reaches(cp, macs, last) {
  if (!cp) return last <= 1;
  return last >= cp.seq && macs.get(cp.seq) === cp.mac;
}

/** The chain check, fed one file at a time, oldest first. */
function chainChecker() {
  /** @type {number | null} */
  let seq = null;
  let prev = '';
  let entries = 0;
  let from = 0;
  /** @type {Map<number, string>} */
  const macs = new Map();
  /** @type {{ file: string, prev: unknown } | null} */
  let first = null;
  /** @type {{ lastSeq: unknown, lastMac: unknown }[]} */
  const pruned = [];
  let lastFile = 'audit.jsonl';
  return {
    /** The first broken entry in this file, or undefined. */
    file(/** @type {string} */ file, /** @type {string} */ text, /** @type {Buffer} */ key) {
      lastFile = file;
      const lines = text.split('\n');
      const torn = lines.pop() !== '';
      for (let i = 0; i < lines.length; i++) {
        const bad = (/** @type {any} */ reason) => ({ ok: /** @type {const} */ (false), entries, file, line: i + 1, reason });
        let e;
        try {
          e = JSON.parse(lines[i]);
        } catch {
          return bad('unreadable');
        }
        if (!isRecord(e) || !Number.isSafeInteger(e.seq)) return bad('unreadable');
        if (!macMatches(key, e)) return bad('mac');
        if (seq === null) {
          from = e.seq;
          first = { file, prev: e.prev };
          if (e.seq === 1 && e.prev !== GENESIS) return bad('link');
        } else {
          if (e.seq !== seq + 1) return bad('gap');
          if (e.prev !== prev) return bad('link');
        }
        seq = e.seq;
        prev = e.mac;
        macs.set(e.seq, e.mac);
        if (e.kind === 'pruned') pruned.push({ lastSeq: e.lastSeq, lastMac: e.lastMac });
        entries++;
      }
      return torn ? { ok: /** @type {const} */ (false), entries, file, line: lines.length + 1, reason: 'torn' } : undefined;
    },
    /** The verdict once every file checked out, against the sealed checkpoint. */
    end(/** @type {{ seq: number, mac: string } | null | 'unreadable'} */ cp) {
      // older files removed by rotation: the entry that removed them names the last one, which the oldest kept links to
      const start = /** @type {{ file: string, prev: unknown } | null} */ (first);
      if (start && from > 1 && !pruned.some((p) => p.lastSeq === from - 1 && p.lastMac === start.prev))
        return { ok: /** @type {const} */ (false), entries: 0, file: start.file, line: 1, reason: 'gap' };
      // a checkpoint that can't be opened says nothing about the end: not a cut, but not checked either
      if (cp === 'unreadable') return { ok: /** @type {const} */ (false), entries, file: lastFile, line: 0, reason: 'checkpoint' };
      if (!reaches(cp, macs, seq ?? 0)) return { ok: /** @type {const} */ (false), entries, file: lastFile, line: 0, reason: 'cut' };
      return { ok: /** @type {const} */ (true), entries, from, last: seq ?? 0 };
    },
  };
}

/**
 * The intents with no outcome, fed one file at a time; `running` says which ones this process still runs (not unfinished).
 * @param {(id: string) => boolean} running
 */
function unfinishedScanner(running) {
  const intents = new Map();
  return {
    file(/** @type {string} */ text, /** @type {Buffer} */ key) {
      for (const line of text.split('\n')) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        // only entries this log wrote count, never a line someone added
        if (!isRecord(e) || typeof e.id !== 'string' || !macMatches(key, e)) continue;
        if (e.kind === 'intent' && !running(e.id)) intents.set(e.id, e);
        else if (e.kind === 'outcome') intents.delete(e.id);
      }
    },
    end() {
      return [...intents.values()].map((e) => ({
        id: e.id,
        action: e.action,
        chatId: e.chatId,
        harness: e.harness,
        account: e.account,
        at: e.at,
      }));
    },
  };
}

module.exports = { GENESIS, reaches, chainChecker, unfinishedScanner };
