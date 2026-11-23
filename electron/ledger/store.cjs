// The request ledger's files: <dir>/YYYY-MM-DD.jsonl (local date), one JSON line per model request. Records are queued
// and appended in batches by one writer (one append in flight), so a turn never waits on the disk; a day's file stops
// at a size cap with one `capped` marker, files older than the retention are folded into the daily rollup and deleted,
// and the Privacy switch turning the ledger off drops what is queued.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { ledgerLine } = require('./line.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { LedgerRollup } = require('./rollup.cjs');
const { LedgerImport, liveSpans, addSpans } = require('./backfill.cjs');
const { usageRows, pricedRows } = require('../../shared/costSummary.mjs');

const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
/** How much of the newest files one read of the log looks through, so a narrow filter never parses the whole month. */
const READ_MAX = 24 * 1024 * 1024;
const DAY_MS = 86_400_000;

/** The local date `now` falls on, as a file name stem. */
function dayOf(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @param {string} text @returns {any[]} the lines of a file that parse, oldest first */
function parseLines(text) {
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const v = JSON.parse(l);
      if (v && typeof v === 'object' && typeof v.t === 'string') out.push(v);
    } catch (error) {
      // a line cut short by a crash mid-append is skipped; the next one starts on its own line
      noteIgnored('read a request ledger line', error);
    }
  }
  return out;
}

/**
 * A read whose file may not exist yet: a missing file reads as `fallback`; any other failure is noted, then reads the same.
 * @template T @param {Promise<T>} p @param {T} fallback @param {string} what
 */
function orMissing(p, fallback, what) {
  return p.catch((error) => {
    if (error?.code !== 'ENOENT') noteIgnored(what, error);
    return fallback;
  });
}

/** @typedef {{ limit?: number, harness?: string, account?: string, outcome?: string, chat?: string }} LedgerFilter */

class RequestLedger {
  /**
   * @param {object} o
   * @param {string | (() => string)} o.dir read when used: main names its userData folder after this is made
   * @param {() => boolean} [o.enabled] the Privacy switch (default on)
   * @param {string} [o.home] replaced with ~ in error text
   * @param {() => number} [o.now]
   * @param {number} [o.keepDays]
   * @param {number} [o.rollupDays] how many days the rollup keeps a day's usage after its raw file is gone
   * @param {number} [o.dayMax] bytes one day's file may reach
   * @param {number} [o.flushMs] how long a record waits for others to join its append
   * @param {number} [o.readMax] characters of the newest files one read of the log looks through
   * @param {Pick<typeof fs.promises, 'appendFile' | 'mkdir' | 'readdir' | 'readFile' | 'stat' | 'unlink'>} [o.fsp]
   * @param {Pick<typeof fs, 'appendFileSync' | 'mkdirSync' | 'existsSync' | 'statSync'>} [o.fsSync]
   */
  constructor(o) {
    this.dirOf = typeof o.dir === 'function' ? o.dir : () => /** @type {string} */ (o.dir);
    this.enabled = o.enabled ?? (() => true);
    this.home = o.home;
    this.now = o.now ?? Date.now;
    this.keepDays = o.keepDays ?? 30;
    this.dayMax = o.dayMax ?? 8 * 1024 * 1024;
    this.flushMs = o.flushMs ?? 500;
    this.readMax = o.readMax ?? READ_MAX;
    this.fsp = o.fsp ?? fs.promises;
    this.fsSync = o.fsSync ?? fs;
    /** @type {{ day: string, line: string }[]} */
    this.queue = [];
    /** @type {Promise<void> | null} */
    this.inflight = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    /** bytes written to each day's file this run (its size on disk once first read), and whether it is capped */
    /** @type {Map<string, { bytes: number, capped: boolean }>} */
    this.days = new Map();
    this.pruned = '';
    const rollupDays = o.rollupDays ?? 400;
    this.oldestKept = () => dayOf(this.now() - rollupDays * DAY_MS);
    this.rollup = new LedgerRollup({ dir: () => this.dir, oldest: this.oldestKept, fsp: this.fsp, dayOf });
    this.imports = new LedgerImport({ dir: () => this.dir, dayOf, fsp: this.fsp });
    /** a past day's reading, kept while its file is unchanged @type {Map<string, { stamp: string, read: any }>} */
    this.dayRows = new Map();
  }

  /** Queues the line for `r`; false when the ledger is off or `r` is not a valid record. */
  record(r) {
    if (!this.enabled()) return false;
    const now = this.now();
    const line = ledgerLine(r, now, { home: this.home });
    if (!line) return false;
    this.queue.push({ day: dayOf(now), line });
    this.timer ??= unref(setTimeout(() => void this.flush(), this.flushMs));
    return true;
  }

  /** Appends what is queued; resolves once that append (and one already in flight) is done. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inflight) return this.inflight.then(() => this.flush());
    if (!this.queue.length) return Promise.resolve();
    const batch = this.queue;
    this.queue = [];
    if (!this.enabled()) return Promise.resolve();
    this.inflight = this.write(batch)
      .catch((error) => noteIgnored('write the request ledger', error))
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** @param {{ day: string, line: string }[]} batch */
  async write(batch) {
    await this.fsp.mkdir(this.dir, { recursive: true });
    for (const day of new Set(batch.map((b) => b.day))) {
      const text = await this.admit(
        day,
        batch.filter((b) => b.day === day).map((b) => b.line),
      );
      if (text) await this.fsp.appendFile(this.file(day), text, { mode: 0o600 });
    }
    await this.prune();
  }

  /** The text of `lines` that fits under the day's cap (its size read once per run), with a `capped` marker once reached. */
  async admit(day, lines) {
    if (!this.days.has(day))
      this.sized(
        day,
        await orMissing(
          this.fsp.stat(this.file(day)).then((s) => s.size),
          0,
          "read the size of the request ledger's day file",
        ),
      );
    return this.fit(day, lines);
  }

  /** Records the size a day's file had on disk when this run first wrote to it. */
  sized(day, size) {
    this.days.set(day, { bytes: size, capped: size >= this.dayMax });
  }

  /** @param {string} day @param {string[]} lines */
  fit(day, lines) {
    const d = /** @type {{ bytes: number, capped: boolean }} */ (this.days.get(day));
    if (d.capped) return '';
    let text = '';
    let bytes = 0;
    for (const line of lines) {
      const n = Buffer.byteLength(line) + 1;
      if (d.bytes + bytes + n > this.dayMax) {
        d.capped = true;
        text += `${JSON.stringify({ v: 1, t: new Date(this.now()).toISOString(), capped: true })}\n`;
        break;
      }
      text += `${line}\n`;
      bytes += n;
    }
    d.bytes += bytes;
    return text;
  }

  /** Quitting: what is queued is written now, synchronously, so the last turn's lines are not lost. */
  flushSync() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue;
    this.queue = [];
    if (!batch.length || !this.enabled()) return;
    try {
      this.fsSync.mkdirSync(this.dir, { recursive: true });
      for (const day of new Set(batch.map((b) => b.day))) {
        // the same cap as every other write: a quit never grows a day's file past it
        if (!this.days.has(day)) this.sized(day, this.fsSync.existsSync(this.file(day)) ? this.fsSync.statSync(this.file(day)).size : 0);
        const text = this.fit(
          day,
          batch.filter((b) => b.day === day).map((b) => b.line),
        );
        if (text) this.fsSync.appendFileSync(this.file(day), text, { mode: 0o600 });
      }
    } catch (error) {
      noteIgnored('write the request ledger at quit', error);
    }
  }

  get dir() {
    return this.dirOf();
  }

  file(day) {
    return path.join(this.dir, `${day}.jsonl`);
  }

  /**
   * Deletes day files older than the retention, once per day, after folding their usage into the rollup. A file that cannot
   * be read, or a rollup that cannot be read or written, keeps every file until a later day's prune.
   */
  async prune() {
    const today = dayOf(this.now());
    if (this.pruned === today) return;
    this.pruned = today;
    const oldest = dayOf(this.now() - this.keepDays * DAY_MS);
    const names = await orMissing(this.fsp.readdir(this.dir), [], 'list the request ledger files');
    const old = names.filter((name) => FILE_RE.test(name) && name.slice(0, 10) < oldest).map((name) => name.slice(0, 10));
    if (!old.length) return;
    /** @type {Record<string, any[]>} */
    const fold = {};
    const readable = [];
    const lines = [];
    for (const day of old) {
      try {
        const dayLines = parseLines(String(await this.fsp.readFile(this.file(day), 'utf8')));
        fold[day] = usageRows(dayLines, day);
        lines.push(...dayLines);
        readable.push(day);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        noteIgnored('read an old request ledger file to fold it', error);
      }
    }
    try {
      await this.rollup.fold(fold, liveSpans(lines));
    } catch (error) {
      noteIgnored('fold old request ledger files into the rollup; they are kept', error);
      return;
    }
    for (const day of readable) {
      await this.fsp.unlink(this.file(day)).catch((error) => noteIgnored('delete an old request ledger file', error));
      this.days.delete(day);
      this.dayRows.delete(day);
    }
  }

  /** Day stems with a file, newest first; `strict`: a folder that cannot be listed (not one that is missing) throws. */
  async daysOnDisk({ strict = false } = {}) {
    const names = strict
      ? await this.fsp.readdir(this.dir).catch((error) => {
          // no folder yet is no requests; a folder that cannot be listed is not
          if (error?.code === 'ENOENT') return [];
          throw error;
        })
      : await orMissing(this.fsp.readdir(this.dir), [], 'list the request ledger files');
    return names
      .filter((n) => FILE_RE.test(n))
      .map((n) => n.slice(0, 10))
      .sort((a, b) => b.localeCompare(a));
  }

  /**
   * The last `limit` lines matching the filter, newest first (after what is queued is written), from at most about
   * `readMax` of the newest files.
   * @param {LedgerFilter} [f]
   */
  async recent(f = {}) {
    await this.flush();
    const limit = Math.min(Math.max(1, Number(f.limit) || 200), 1000);
    const match = (l) =>
      !l.capped &&
      (!f.harness || l.harness === f.harness) &&
      (!f.account || l.account?.id === f.account || l.account?.email === f.account) &&
      (!f.outcome || l.outcome === f.outcome) &&
      (!f.chat || l.chat === f.chat);
    const out = [];
    let read = 0;
    for (const day of await this.daysOnDisk()) {
      const text = String(await orMissing(this.fsp.readFile(this.file(day), 'utf8'), '', 'read a request ledger file'));
      const lines = parseLines(text).filter(match).reverse();
      out.push(...lines.slice(0, limit - out.length));
      read += text.length;
      if (out.length >= limit || read >= this.readMax) break;
    }
    return out;
  }

  /**
   * Usage and cost at list price from `from` to `to` (day stems, both included), by day, harness, model and way of paying: the raw
   * files where they are kept, the rollup for days before them. `rollup` says whether the rolled-up days the range reaches could be
   * read, `unread` names the raw days that could not be: a summary that misses either is shown as incomplete, never as less usage. A
   * ledger folder that cannot be listed rejects. The usage imported from sessions run outside MoPilot (backfill.cjs) is added on every
   * day it falls on; `imported` says whether it could be read.
   * @param {{ from?: string, to?: string }} [range]
   * @returns {Promise<{ rows: import('../../shared/costSummary.mjs').PricedRow[], rollup: 'ok' | 'unreadable', unread: string[], imported: 'ok' | 'unreadable' }>}
   */
  async summary(range = {}) {
    await this.flush();
    const from = range.from ?? '0000-00-00';
    const to = range.to ?? '9999-99-99';
    const today = dayOf(this.now());
    const rows = [];
    const raw = new Set();
    const unread = [];
    /** what MoPilot recorded itself, over every raw day, for the import to leave out @type {import('./backfill.cjs').LiveIndex} */
    const live = { keys: new Set(), spans: new Map() };
    const listed = await this.daysOnDisk({ strict: true });
    // the rollup holds only days before the oldest raw file: a range that starts there or later needs none of its days
    let needsRollup = !listed.length || from < listed[listed.length - 1];
    for (const day of listed) {
      const inRange = day >= from && day <= to;
      try {
        const read = await this.readDay(day, day === today);
        // a file the retention folded and deleted meanwhile is read from the rollup below
        if (!read) {
          needsRollup ||= inRange;
          continue;
        }
        for (const k of read.keys) live.keys.add(k);
        addSpans(live.spans, read.spans);
        if (!inRange) continue;
        raw.add(day);
        rows.push(...read.rows);
      } catch (error) {
        noteIgnored('read a request ledger file for its usage', error);
        if (!inRange) continue;
        raw.add(day);
        unread.push(day);
      }
    }
    let rollup = /** @type {'ok' | 'unreadable'} */ ('ok');
    let imported = /** @type {'ok' | 'unreadable'} */ ('ok');
    try {
      const folded = await this.rollup.load();
      addSpans(live.spans, folded.live);
      live.spanless = new Set(folded.spanless);
      if (needsRollup) {
        for (const [day, dayRows] of Object.entries(folded.days)) if (day >= from && day <= to && !raw.has(day)) rows.push(...dayRows);
        if (await this.rollup.setAside()) rollup = 'unreadable';
      }
    } catch (error) {
      noteIgnored("read the request ledger's rollup", error);
      rollup = 'unreadable';
      // without the rollup's live sessions an import could count what MoPilot recorded: it is left out until it can be read
      imported = 'unreadable';
    }
    if (imported === 'ok')
      try {
        rows.push(...(await this.imports.rows({ from, to, oldest: this.oldestKept() }, live)));
        // an import store set aside as unreadable held history the transcripts may no longer have, up to the day it was set aside
        const aside = await this.imports.setAside();
        if (aside && from <= aside) imported = 'unreadable';
      } catch (error) {
        noteIgnored("read the request ledger's imported usage", error);
        imported = 'unreadable';
      }
    return { rows: pricedRows(rows), rollup, unread, imported };
  }

  /**
   * Imports the usage of Claude Code and Codex sessions that ran outside MoPilot (backfill.cjs); refused while the Privacy switch has
   * the request log off, also when it is turned off before the import ends. What MoPilot recorded itself is left out when the
   * summary reads it, so it is never counted twice.
   * @param {{ claude: string, codex: string[] }} roots Claude Code's transcripts folder and the folders of the user's CODEX_HOME that
   *   hold its rollouts
   */
  async importOutside(roots) {
    if (!this.enabled()) return { refused: 'off' };
    return this.imports.importOutside(roots, this.enabled);
  }

  /**
   * One day file's usage rows, the keys of its requests and its live sessions (for what an import leaves out), or null when the file
   * is gone; a past day's are kept while its file's size and modification time are unchanged. A read that fails otherwise throws,
   * and nothing is kept for it.
   * @param {string} day @param {boolean} live
   * @returns {Promise<{ rows: any[], keys: string[], spans: Record<string, import('./rollup.cjs').Span> } | null>}
   */
  async readDay(day, live) {
    /** @type {string | null} */
    let stamp = null;
    if (!live) {
      try {
        const s = await this.fsp.stat(this.file(day));
        stamp = `${s.size}:${s.mtimeMs}`;
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    }
    const kept = this.dayRows.get(day);
    if (kept && stamp && kept.stamp === stamp) return kept.read;
    let text;
    try {
      text = String(await this.fsp.readFile(this.file(day), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const lines = parseLines(text);
    const read = {
      rows: usageRows(lines, day),
      keys: lines.flatMap((l) => (typeof l.key === 'string' ? [l.key] : [])),
      spans: liveSpans(lines),
    };
    if (stamp) this.dayRows.set(day, { stamp, read });
    return read;
  }

  /** The raw lines of the last 24 hours, oldest first, at most `max` of them (for Copy diagnostics). */
  async lastDay(max = 200) {
    await this.flush();
    const since = new Date(this.now() - DAY_MS).toISOString();
    const lines = [];
    for (const day of (await this.daysOnDisk()).slice(0, 2).reverse()) {
      const text = await orMissing(this.fsp.readFile(this.file(day), 'utf8'), '', 'read a request ledger file');
      for (const l of parseLines(String(text))) if (l.t >= since) lines.push(JSON.stringify(l));
    }
    return lines.slice(-max);
  }
}

/** A timer that does not keep the process alive. */
function unref(t) {
  t?.unref?.();
  return t;
}

module.exports = { RequestLedger, dayOf, parseLines };
