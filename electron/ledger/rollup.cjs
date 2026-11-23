// The request ledger's daily rollup, <dir>/days.json: the usage of each day whose raw file the retention deleted, by harness, model and
// way of paying (shared/costSummary.mjs rows; no chat, prompt or error), so cost history outlives the 30 days of raw lines. A day is
// folded in, and the rollup flushed to disk, before its raw file goes. A rollup that cannot be opened is never written over, and the raw
// files wait; one whose content cannot be parsed is set aside whole (days.unreadable-<time>.json, never deleted) and a new one started,
// so the raw files' retention keeps running and summaries say their history is incomplete.
const { fs } = require('../platform/ports/fs.cjs');
const { randomUUID } = require('node:crypto');
const { writeAtomicAsync } = require('../platform/fsutil.cjs');
const { syncFolderAsync } = require('../platform/folderSync.cjs');
const path = require('node:path');
const { isUsageRow } = require('../../shared/costSummary.mjs');

const FILE = 'days.json';
const ASIDE_RE = /^days\.unreadable-[\w.-]+\.json$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A rollup file that exists but is not one this version can read: its history is kept, not replaced. */
class RollupUnreadable extends Error {
  /** @param {string} reason @param {boolean} content true when the file was read and its content is not a rollup */
  constructor(reason, content) {
    super(`The request ledger's rollup cannot be read: ${reason}`);
    this.code = 'ROLLUP_UNREADABLE';
    this.content = content;
  }
}

/**
 * Writes `text` to `file` atomically and owner-only (fsutil writeAtomicAsync), then flushes the file and its folder to disk, so a
 * power cut after a raw day file is deleted never leaves the rollup without that day. A flush that fails fails the write, and the
 * raw files it would have replaced are kept.
 * @param {string} file @param {string} text
 */
async function writeDurable(file, text) {
  await writeAtomicAsync(file, text, () => true, 0o600);
  await flushToDisk(file);
  // the folder too, so the rename is on the disk (nothing to do on Windows, which journals it: platform/folderSync.cjs)
  await syncFolderAsync(path.dirname(file), { fs: fs.promises });
}

/** fsync of a file or folder by a read-only handle. @param {string} target */
async function flushToDisk(target) {
  const handle = await fs.promises.open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** @typedef {import('../../shared/costSummary.mjs').UsageRow} UsageRow */
/** A live session's first and last request, as ISO times. @typedef {{ first: string, last: string }} Span */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
/** @param {unknown} v @returns {v is Span} */
const isSpan = (v) => {
  const s = /** @type {any} */ (v);
  return !!s && typeof s === 'object' && ISO_RE.test(s.first) && ISO_RE.test(s.last) && s.first <= s.last;
};

class LedgerRollup {
  /**
   * @param {object} o
   * @param {() => string} o.dir the ledger's folder
   * @param {number} [o.keepDays] how many days of rollup are kept
   * @param {() => string} o.oldest the oldest day stem kept, from `keepDays` before today
   * @param {(ms: number) => string} [o.dayOf] the local day stem of a time, which a live session's span is kept by (store.cjs dayOf)
   * @param {Pick<typeof fs.promises, 'readFile' | 'readdir'>} [o.fsp]
   * @param {(file: string, text: string) => Promise<void>} [o.write]
   */
  constructor(o) {
    this.dirOf = o.dir;
    this.oldest = o.oldest;
    this.dayOf = o.dayOf ?? ((/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10));
    this.fsp = o.fsp ?? fs.promises;
    this.write = o.write ?? writeDurable;
    /** @type {(from: string, to: string) => Promise<void>} */
    this.rename = (from, to) => fs.promises.rename(from, to);
    /** one fold at a time, in the order asked: the last fold, settled */
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
  }

  get file() {
    return path.join(this.dirOf(), FILE);
  }

  /**
   * The rolled-up days, day → rows; empty when there is no rollup yet.
   * @returns {Promise<Record<string, UsageRow[]>>} @throws {RollupUnreadable} when the file is there but cannot be read
   */
  async read() {
    return (await this.load()).days;
  }

  /**
   * The rolled-up days and the live sessions folded with them: each session MoPilot ran, by `identityKey(harness, session)`, with
   * its first and last request's time, so an import of the harness's own transcripts leaves those requests out (backfill.cjs).
   * `spanless`: the days not known to be folded with their live sessions (`spanned` lists those that are). A version that kept no
   * live sessions, or did not know this list, wrote none: what MoPilot recorded on its days cannot be told apart from an import's,
   * so an import counts nothing on them. A writer that drops the list makes its days spanless, an undercount, never a double count.
   * @returns {Promise<{ days: Record<string, UsageRow[]>, live: Record<string, Span>, spanless: string[] }>}
   * @throws {RollupUnreadable} when the file is there but cannot be read
   */
  async load() {
    let text;
    try {
      text = await this.fsp.readFile(this.file, 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return { days: {}, live: {}, spanless: [] };
      throw new RollupUnreadable(String(/** @type {any} */ (error)?.code ?? error), false);
    }
    let v;
    try {
      v = JSON.parse(String(text));
    } catch {
      throw new RollupUnreadable('it is not JSON', true);
    }
    if (!v || v.v !== 1 || !v.days || typeof v.days !== 'object' || Array.isArray(v.days))
      throw new RollupUnreadable('unknown format', true);
    /** @type {Record<string, UsageRow[]>} */
    const days = Object.create(null);
    for (const [day, rows] of Object.entries(v.days)) {
      if (!DAY_RE.test(day) || !Array.isArray(rows) || !rows.every(isUsageRow)) throw new RollupUnreadable(`day ${day.slice(0, 20)}`, true);
      days[day] = rows;
    }
    /** @type {Record<string, Span>} */
    const live = Object.create(null);
    // a rollup written before the live sessions were kept has none
    const spans = v.live === undefined ? {} : v.live;
    if (!spans || typeof spans !== 'object' || Array.isArray(spans)) throw new RollupUnreadable('live sessions', true);
    for (const [key, span] of Object.entries(spans)) {
      if (!isSpan(span)) throw new RollupUnreadable('a live session', true);
      live[key] = span;
    }
    // a rollup with no live sessions has no day folded with them
    const spanned = v.live === undefined ? [] : (v.spanned ?? []);
    if (!Array.isArray(spanned) || !spanned.every((d) => typeof d === 'string' && DAY_RE.test(d)))
      throw new RollupUnreadable('days with live sessions', true);
    return {
      days,
      live,
      spanless: Object.keys(days)
        .filter((d) => !spanned.includes(d))
        .sort(),
    };
  }

  /**
   * Sets each day's rows (a day folded again is replaced, never added twice), widens each live session's span by the one folded
   * with it, and drops days and sessions past the retention.
   * @param {Record<string, UsageRow[]>} add @param {Record<string, Span>} [live]
   * @returns {Promise<void>} rejects, writing nothing, when the rollup cannot be read
   */
  fold(add, live = {}) {
    const run = this.chain.then(async () => {
      const was = await this.load().catch(async (error) => {
        if (!(error instanceof RollupUnreadable) || !error.content) throw error;
        await this.rename(
          this.file,
          path.join(this.dirOf(), `days.unreadable-${new Date().toISOString().replace(/:/g, '-')}-${randomUUID().slice(0, 8)}.json`),
        );
        return { days: /** @type {Record<string, UsageRow[]>} */ ({}), live: /** @type {Record<string, Span>} */ ({}), spanless: [] };
      });
      const { days } = was;
      for (const [day, rows] of Object.entries(add)) days[day] = rows;
      // a day folded now comes with its live sessions
      const spanless = new Set(was.spanless.filter((d) => !(d in add)));
      const oldest = this.oldest();
      /** @type {Record<string, UsageRow[]>} */
      const kept = {};
      for (const day of Object.keys(days).sort()) if (day >= oldest) kept[day] = days[day];
      /** @type {Record<string, Span>} */
      const spans = {};
      for (const [key, span] of [...Object.entries(was.live), ...Object.entries(live)]) {
        const had = spans[key];
        spans[key] = had
          ? { first: had.first < span.first ? had.first : span.first, last: had.last > span.last ? had.last : span.last }
          : span;
      }
      // by the local day it ended on, as the days are kept: a session the rollup still holds a day of keeps its span
      for (const [key, span] of Object.entries(spans)) if (this.dayOf(Date.parse(span.last)) < oldest) delete spans[key];
      const spanned = Object.keys(kept).filter((d) => !spanless.has(d));
      await this.write(this.file, `${JSON.stringify({ v: 1, days: kept, live: spans, spanned })}\n`);
    });
    this.chain = Promise.allSettled([run]);
    return run;
  }

  /** Whether a rollup was set aside as unreadable: the days it held are missing from every summary. */
  async setAside() {
    const names = await this.fsp.readdir(this.dirOf()).catch((error) => {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
      throw error;
    });
    return names.some((n) => ASIDE_RE.test(String(n)));
  }
}

module.exports = { LedgerRollup, RollupUnreadable, writeDurable, isSpan };
