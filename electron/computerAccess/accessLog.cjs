// Computer access (#1364): the access log the person reads in Settings → Computer access. One JSON line per event
// (a pairing asked, allowed or denied, a device connected, refused, revoked, a call and how it ended, a stop) in
// <dir>/YYYY-MM-DD.jsonl (local date), written in the background with the chat transcripts. A line keeps ids, names,
// the tool, the names of its arguments and the outcome: never an argument's value, a page or a screenshot.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { TranscriptWriter } = require('../platform/transcriptWriter.cjs');
const { dayOf, parseLines } = require('../ledger/store.cjs');
const { noteIgnored } = require('../ignored.cjs');

const EVENTS = new Set(['pairing', 'paired', 'denied', 'connected', 'disconnected', 'refused', 'revoked', 'call', 'stop', 'off']);
/** How long one text field may be. */
const TEXT_MAX = 200;
/** How many days of files a read looks through. */
const READ_DAYS = 7;

const text = (v) => (typeof v === 'string' && v ? [...v].slice(0, TEXT_MAX).join('') : undefined);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/**
 * The line kept for an event, or null for one this log doesn't know.
 * @param {any} e @param {number} now
 */
function accessLine(e, now) {
  if (!e || !EVENTS.has(e.event)) return null;
  return {
    t: new Date(now).toISOString(),
    event: e.event,
    device: text(e.device),
    deviceName: text(e.deviceName),
    chat: text(e.chat),
    harness: text(e.harness),
    tool: text(e.tool),
    policy: text(e.policy),
    argKeys: Array.isArray(e.argKeys)
      ? e.argKeys
          .filter((k) => typeof k === 'string')
          .slice(0, 20)
          .map(text)
      : undefined,
    outcome: text(e.outcome),
    code: text(e.code),
    ms: count(e.ms),
  };
}

class AccessLog {
  /**
   * @param {{ dir: string | (() => string), now?: () => number, max?: number,
   *   writer?: { append(file: string, lines: string[], opts?: { mode?: number, what?: string }): void },
   *   fsp?: Pick<typeof fs.promises, 'readFile'> }} o
   */
  constructor(o) {
    this.dirOf = typeof o.dir === 'function' ? o.dir : () => /** @type {string} */ (o.dir);
    this.now = o.now ?? Date.now;
    this.max = o.max ?? 500;
    this.writer = o.writer ?? new TranscriptWriter();
    this.fsp = o.fsp ?? fs.promises;
    /** @type {any[]} this run's lines, newest last */
    this.entries = [];
    /** @type {Set<() => void>} */
    this.listeners = new Set();
  }

  /** Records an event; returns its line, or null for an event this log doesn't know. */
  add(e) {
    const now = this.now();
    const line = accessLine(e, now);
    if (!line) return null;
    this.entries.push(line);
    if (this.entries.length > this.max) this.entries.shift();
    this.writer.append(path.join(this.dirOf(), `${dayOf(now)}.jsonl`), [`${JSON.stringify(line)}\n`], {
      mode: 0o600,
      what: 'append to the computer access log',
    });
    for (const fn of this.listeners) fn();
    return line;
  }

  /** Calls `fn` after each line; returns a function that stops it. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** This run's newest lines, newest first. */
  recent(n = 100) {
    return this.entries.slice(-n).reverse();
  }

  /**
   * The newest lines on disk (the last week), newest first, with this run's lines that are not written yet.
   * @param {number} [limit]
   */
  async read(limit = 200) {
    const out = [];
    const day = 86_400_000;
    for (let i = 0; i < READ_DAYS && out.length < limit; i++) {
      const file = path.join(this.dirOf(), `${dayOf(this.now() - i * day)}.jsonl`);
      const lines = await this.fsp.readFile(file, 'utf8').then(parseLines, (error) => {
        if (error?.code !== 'ENOENT') noteIgnored('read the computer access log', error);
        return [];
      });
      out.push(...lines.reverse());
    }
    // a line still queued for the disk is shown too, once
    const seen = new Set(out.map((l) => JSON.stringify(l)));
    const pending = this.recent(limit).filter((l) => !seen.has(JSON.stringify(l)));
    return [...pending, ...out].sort((a, b) => b.t.localeCompare(a.t)).slice(0, limit);
  }
}

module.exports = { AccessLog, accessLine, EVENTS };
