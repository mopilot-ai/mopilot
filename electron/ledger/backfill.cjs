// Usage of Claude Code and Codex sessions that ran outside MoPilot (the terminal, another app), read from the harnesses' own files
// (Claude Code's transcripts, <CLAUDE_CONFIG_DIR or ~/.claude>/projects/**/*.jsonl, and Codex's rollouts, rollout-*.jsonl[.zst] in the
// folders harness/codexRollout.cjs names for a CODEX_HOME, read by the core's rollout.usage; MoPilot's own sessions' included) into the request
// ledger's import store, <dir>/imported.json: per file, its harness, size and modification time and its requests (id, session,
// time, model, token counts; never a prompt, reply or tool content), so a file that grew is read again and one that was deleted
// keeps its history. What counts is decided each time it is read (rows): each request id once over every file (a fork or a resume
// copies a session's history into a new file: a copied Claude record says forkedFrom, a copied Codex request's record names its
// own thread; an archived or compressed rollout is a new path with the same ids), and nothing MoPilot recorded itself: a request whose
// key is in a raw day file (a Codex request's key is the live tap's, <thread>:<total>), or one of a session MoPilot ran up to that
// session's last request with usage (live spans, the same from raw days and from the rollup once they are folded). So a request
// MoPilot records after an import is left out from then on, and a request run elsewhere while MoPilot had the same session open is
// left out too: a small undercount, never a double count.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { noteIgnored } = require('../ignored.cjs');
const { openFramer } = require('../platform/coreFraming.cjs');
const { coreCall } = require('../platform/core.cjs');
const { identityKey } = require('../../shared/identityKey.mjs');
const { countsUsage, usageRows } = require('../../shared/costSummary.mjs');
const { writeDurable } = require('./rollup.cjs');

const FILE = 'imported.json';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
/**
 * Harnesses whose sessions are another's own, by the family whose files hold them: Claude Code's projects folder, Codex's rollouts (the
 * Codex ACP adapter's sessions are Codex threads). A family's spans are one session's whichever harness ran it.
 */
const FAMILY = new Map([
  ['claude-acp', 'claude'],
  ['host-claude', 'claude'],
  ['codex-acp', 'codex'],
]);
/**
 * Offsets from UTC whose dates cover every date a time has in some time zone (UTC−12 to UTC+14, the middle one for the date between
 * two midnights 26 hours apart): a day stem kept in one zone is one of them.
 */
const ZONE_OFFSETS_MS = [-12, 1, 14].map((h) => h * 3_600_000);
const ASIDE_RE = /^imported\.unreadable-(\d{4}-\d{2}-\d{2})T[\w.-]+\.json$/;
/** A Codex rollout's name (rollout-<time>-<thread>.jsonl, or .jsonl.zst once Codex compressed it). */
const ROLLOUT_RE = /^rollout-.+\.jsonl(\.zst)?$/;
/** The store's version: 2 says which harness each file is (an older version reads every file as Claude Code's, so it refuses this one). */
const VERSION = 2;
/** What each source's files are, for a note when one cannot be read. */
const NAMES = { claude: 'Claude Code transcript', codex: 'Codex rollout' };

/** An import store that exists but cannot be read. `content`: it was read and is not one this version can read. */
class ImportUnreadable extends Error {
  /** @param {string} reason @param {boolean} content */
  constructor(reason, content) {
    super(`The imported usage cannot be read: ${reason}`);
    this.code = 'IMPORT_UNREADABLE';
    this.content = content;
  }
}

/**
 * @typedef {import('./rollup.cjs').Span} Span
 * @typedef {{ keys: Set<string>, spans: Map<string, Span>, spanless?: Set<string> }} LiveIndex what MoPilot recorded itself:
 *   request keys, each live session's span by spanKey(harness, session), and the rollup's days folded with no spans (rollup.cjs)
 * @typedef {[id: string, session: string, t: string, model: string | null, i: number, o: number, cr: number, cw: number]} Request
 * @typedef {'claude' | 'codex'} Source whose files: Claude Code's transcripts or Codex's rollouts
 * @typedef {{ stamp: string, requests: Request[], harness?: 'codex' }} ImportedFile a file's requests; Claude Code's says no harness
 * @typedef {Record<string, ImportedFile>} Imported file path → its requests
 * @typedef {{ files: number, read: number, failed: number }} Found files seen, those read because they were new or changed, and those
 *   that could not be read (they keep what an earlier import found)
 */

/** A live session's key: a Claude Code session, or a Codex thread, is one session whichever harness ran it. @param {string} harness @param {string} session */
const spanKey = (harness, session) => identityKey(FAMILY.get(harness) ?? harness, session);

/** Two spans of one session as one. @param {Span | undefined} a @param {Span} b @returns {Span} */
const widen = (a, b) => (a ? { first: a.first < b.first ? a.first : b.first, last: a.last > b.last ? a.last : b.last } : b);

/**
 * The live sessions in some ledger lines: each session's first and last request that reported usage (a retry, a stop or an error
 * line carries none, and draws no span), by spanKey(harness, session). Raw days and folded ones draw them the same way, so a day's
 * total does not change when it is folded.
 * @param {any[]} lines @returns {Record<string, Span>}
 */
function liveSpans(lines) {
  /** @type {Record<string, Span>} */
  const out = {};
  for (const l of lines) {
    if (!countsUsage(l) || typeof l.session !== 'string' || typeof l.t !== 'string') continue;
    const key = spanKey(l.harness, l.session);
    out[key] = widen(out[key], { first: l.t, last: l.t });
  }
  return out;
}

/** Spans added into a map, widening the ones it holds. @param {Map<string, Span>} into @param {Record<string, Span>} spans */
function addSpans(into, spans) {
  for (const [key, span] of Object.entries(spans)) into.set(key, widen(into.get(key), span));
  return into;
}

/** Whether MoPilot recorded a request itself. @param {LiveIndex} live @param {Request} r @param {Source} [harness] */
function recorded(live, r, harness = 'claude') {
  if (live.keys.has(r[0])) return true;
  // a session MoPilot ran owns its requests up to its last recorded one: the ledger writes a request after the transcript holds it,
  // so the session's first request comes before the span's first line
  const span = live.spans.get(spanKey(harness, r[1]));
  return !!span && r[2] <= span.last;
}

const count = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * One transcript's requests: one per message id (its usage repeats on each of its records, and the last record's is final), at the
 * time of its last record. A record a fork or resume copied from another session (forkedFrom) is that session's, and left out here.
 * @param {AsyncIterable<string> | Iterable<string>} lines @returns {Promise<Request[]>}
 */
async function claudeRequests(lines) {
  /** @type {Map<string, Request>} */
  const byId = new Map();
  for await (const raw of lines) {
    // Claude Code writes each record on one compact line: only an assistant's carries usage, so the rest are not parsed
    if (!raw.includes('"type":"assistant"')) continue;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    const m = d?.type === 'assistant' ? d.message : null;
    if (!m || typeof m.id !== 'string' || !m.usage || typeof d.sessionId !== 'string' || d.forkedFrom) continue;
    if (typeof d.timestamp !== 'string' || !ISO_RE.test(d.timestamp) || m.model === '<synthetic>') continue;
    const u = m.usage;
    const model = typeof m.model === 'string' && m.model ? m.model : null;
    byId.set(m.id, [
      m.id,
      d.sessionId,
      d.timestamp,
      model,
      count(u.input_tokens),
      count(u.output_tokens),
      count(u.cache_read_input_tokens),
      count(u.cache_creation_input_tokens),
    ]);
  }
  return [...byId.values()];
}

/** @param {unknown} v @returns {v is Request} */
const isRequest = (v) =>
  Array.isArray(v) &&
  v.length === 8 &&
  typeof v[0] === 'string' &&
  typeof v[1] === 'string' &&
  typeof v[2] === 'string' &&
  ISO_RE.test(v[2]) &&
  (v[3] === null || typeof v[3] === 'string') &&
  v.slice(4).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);

/**
 * A Codex rollout's requests, read by the core (core/crates/rollout usage.rs): one per change of the thread's total, keyed as the
 * live tap keys it. A request the core gives in a shape this version cannot store fails the file, so it keeps what it had.
 * @param {string} file @param {typeof coreCall} [call] @returns {Promise<Request[]>}
 */
async function codexRequests(file, call = coreCall) {
  const list = await call('rollout.usage', undefined, file);
  if (!Array.isArray(list) || !list.every(isRequest)) throw new Error("The core's rollout usage is not a list of requests");
  return list;
}

/**
 * A file's lines, read as a stream so a large transcript is never held whole, framed by the core (platform/coreFraming.cjs). A last
 * line with no newline yet is one Claude Code is still writing, and is read at the next import.
 * @param {string} file @param {number} [maxUnits] the longest line it reads (the framer's own limit unless given)
 * @returns {AsyncIterable<string>}
 */
async function* fileLines(file, maxUnits = undefined) {
  const framer = openFramer(maxUnits);
  try {
    for await (const chunk of fs.createReadStream(file)) {
      const framed = framer.push(/** @type {Buffer} */ (chunk));
      for (const line of framed.lines) yield line.toString('utf8');
      // past a line longer than the framer takes it reads nothing more: the transcript is not read whole, so it is not taken as read
      if (framed.tooLong) throw Object.assign(new Error('A transcript line is too long to read'), { code: 'ETOOLONG' });
    }
  } finally {
    framer.close();
  }
}

class LedgerImport {
  /**
   * @param {object} o
   * @param {() => string} o.dir the ledger's folder
   * @param {(ms: number) => string} o.dayOf the local day stem of a time (store.cjs dayOf)
   * @param {Pick<typeof fs.promises, 'readFile' | 'readdir' | 'stat'>} [o.fsp]
   * @param {(file: string) => AsyncIterable<string>} [o.lines] a transcript's lines
   * @param {(file: string) => Promise<Request[]>} [o.rollout] a Codex rollout's requests
   * @param {(file: string, text: string) => Promise<void>} [o.write]
   * @param {() => Promise<void>} [o.pause] lets other work run between transcripts
   */
  constructor(o) {
    this.dirOf = o.dir;
    this.dayOf = o.dayOf;
    this.fsp = o.fsp ?? fs.promises;
    this.lines = o.lines ?? fileLines;
    /** each source's reader: a file's requests @type {Record<Source, (file: string) => Promise<Request[]>>} */
    this.readers = { claude: (file) => claudeRequests(this.lines(file)), codex: o.rollout ?? codexRequests };
    this.write = o.write ?? writeDurable;
    this.pause = o.pause ?? (() => new Promise((r) => setImmediate(r)));
    /** @type {(from: string, to: string) => Promise<void>} */
    this.rename = (from, to) => fs.promises.rename(from, to);
    /** @type {Promise<any> | null} one import at a time; a second ask joins the one running */
    this.running = null;
    /** the store as last read, with each id's request once over every file @type {{ stamp: string, union: { r: Request, harness: Source }[] } | null} */
    this.cache = null;
  }

  get file() {
    return path.join(this.dirOf(), FILE);
  }

  /** What was imported, by transcript; empty before the first import. @returns {Promise<Imported>} @throws {ImportUnreadable} */
  async read() {
    let text;
    try {
      text = await this.fsp.readFile(this.file, 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return {};
      throw new ImportUnreadable(String(/** @type {any} */ (error)?.code ?? error), false);
    }
    let v;
    try {
      v = JSON.parse(String(text));
    } catch {
      throw new ImportUnreadable('it is not JSON', true);
    }
    // version 1 held Claude Code's transcripts only
    if (!v || (v.v !== 1 && v.v !== VERSION) || !v.files || typeof v.files !== 'object' || Array.isArray(v.files))
      throw new ImportUnreadable('unknown format', true);
    /** @type {Imported} */
    const files = Object.create(null);
    for (const [file, f] of Object.entries(v.files)) {
      const e = /** @type {any} */ (f);
      const codex = v.v === VERSION && e?.harness === 'codex';
      if (!e || typeof e.stamp !== 'string' || !Array.isArray(e.requests) || !e.requests.every(isRequest))
        throw new ImportUnreadable('a transcript', true);
      if (e.harness !== undefined && !codex) throw new ImportUnreadable('a harness', true);
      files[file] = codex ? { stamp: e.stamp, requests: e.requests, harness: 'codex' } : { stamp: e.stamp, requests: e.requests };
    }
    return files;
  }

  /**
   * Each request id's request once over every file, the copy with the most output, with its harness; kept while the store is unchanged.
   * @returns {Promise<{ r: Request, harness: Source }[]>}
   */
  async union() {
    const stamp = await this.fsp.stat(this.file).then(
      (s) => `${s.size}:${s.mtimeMs}`,
      (error) => {
        if (error?.code === 'ENOENT') return 'none';
        throw new ImportUnreadable(String(error?.code ?? error), false);
      },
    );
    if (this.cache?.stamp === stamp) return this.cache.union;
    const files = stamp === 'none' ? {} : await this.read();
    /** @type {Map<string, { r: Request, harness: Source }>} */
    const byId = new Map();
    for (const file of Object.keys(files).sort()) {
      const harness = files[file].harness ?? 'claude';
      for (const r of files[file].requests) {
        // a copy (a subagent's, a resume's) may hold a request cut short: the one with the most output is the request as it ended
        const id = identityKey(harness, r[0]);
        const had = byId.get(id);
        if (!had || r[5] > had.r[5]) byId.set(id, { r, harness });
      }
    }
    const union = [...byId.values()];
    this.cache = { stamp, union };
    return union;
  }

  /**
   * The day the latest import store was set aside as unreadable, or null when none was: a transcript Claude Code deleted before then
   * is missing from the days up to it (the import that set it aside read every transcript still there again).
   * @returns {Promise<string | null>}
   */
  async setAside() {
    const names = await this.fsp.readdir(this.dirOf()).catch((error) => {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
      throw error;
    });
    const days = names.flatMap((n) => ASIDE_RE.exec(String(n))?.slice(1, 2) ?? []).sort();
    return days.at(-1) ?? null;
  }

  /**
   * The imported usage from `from` to `to`, left out what MoPilot recorded itself and days before `oldest` (the rollup's retention).
   * @param {{ from: string, to: string, oldest: string }} range @param {LiveIndex} live
   */
  async rows(range, live) {
    const lines = [];
    for (const { r, harness } of await this.union()) {
      if (recorded(live, r, harness)) continue;
      const ms = Date.parse(r[2]);
      const day = this.dayOf(ms);
      if (day < range.from || day > range.to || day < range.oldest) continue;
      // on a day folded with no live sessions, what MoPilot recorded cannot be told apart: nothing imported counts on it, in
      // whichever time zone the day was folded
      const { spanless } = live;
      if (spanless?.size && ZONE_OFFSETS_MS.some((o) => spanless.has(new Date(ms + o).toISOString().slice(0, 10)))) continue;
      lines.push({
        harness,
        day,
        served: r[3] ?? undefined,
        pay: 'unknown',
        in: r[4],
        out: r[5],
        cacheRead: r[6],
        cacheWrite: r[7],
      });
    }
    return usageRows(lines, (l) => String(l.day));
  }

  /**
   * Reads every Claude Code transcript under `roots.claude` and every Codex rollout under `roots.codex` (a CODEX_HOME's rollout folders) that is new or
   * changed since the last import and saves its requests. One import runs at a time: a second ask joins the one running. Nothing is
   * saved when `enabled` says no by the end (the Privacy switch turned off meanwhile).
   * @param {{ claude: string, codex: string[] }} roots @param {() => boolean} enabled
   * @returns {Promise<{ claude: Found, codex: Found } | { refused: 'off' }>}
   */
  importOutside(roots, enabled) {
    this.running ??= this.run(roots, enabled).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** @param {{ claude: string, codex: string[] }} roots @param {() => boolean} enabled */
  async run(roots, enabled) {
    const files = await this.read().catch(async (error) => {
      // a store this version cannot read is set aside whole, never written over, and the import starts again
      if (!(error instanceof ImportUnreadable) || !error.content) throw error;
      const aside = `imported.unreadable-${new Date().toISOString().replace(/:/g, '-')}-${randomUUID().slice(0, 8)}.json`;
      await this.rename(this.file, path.join(this.dirOf(), aside));
      return /** @type {Imported} */ ({});
    });
    const claude = await this.list([roots.claude], (name) => name.endsWith('.jsonl'), `${NAMES.claude}s`);
    const listed = new Set(claude);
    // a folder both roots reach is Claude Code's
    const codex = (await this.list(roots.codex, (name) => ROLLOUT_RE.test(name), `${NAMES.codex}s`)).filter((f) => !listed.has(f));
    const found = { claude: { files: claude.length, read: 0, failed: 0 }, codex: { files: codex.length, read: 0, failed: 0 } };
    for (const [harness, list] of /** @type {const} */ ([
      ['claude', claude],
      ['codex', codex],
    ]))
      for (const file of list) {
        await this.pause();
        let st;
        try {
          st = await this.fsp.stat(file);
        } catch (error) {
          // one gone since it was listed is no failure
          if (/** @type {any} */ (error)?.code !== 'ENOENT') found[harness].failed += 1;
          noteIgnored(`read a ${NAMES[harness]} to import its usage`, error, ['ENOENT']);
          continue;
        }
        const stamp = `${st.size}:${st.mtimeMs}`;
        if (files[file]?.stamp === stamp) continue;
        try {
          const requests = await this.readers[harness](file);
          files[file] = harness === 'codex' ? { stamp, requests, harness } : { stamp, requests };
          found[harness].read += 1;
        } catch (error) {
          // a file that cannot be read (now, or whole) keeps what an earlier import found in it
          found[harness].failed += 1;
          noteIgnored(`read a ${NAMES[harness]} to import its usage`, error, ['ENOENT']);
        }
      }
    if (!enabled()) return { refused: /** @type {const} */ ('off') };
    await this.write(this.file, `${JSON.stringify({ v: VERSION, files })}\n`);
    return found;
  }

  /**
   * Every file under `roots` whose name `match` takes, however deep (Claude Code sessions' subagents and workflows included), sorted;
   * none from a root that does not exist.
   * @param {string[]} roots @param {(name: string) => boolean} match @param {string} what what they are, for a folder that cannot be listed
   */
  async list(roots, match, what) {
    const out = [];
    const walk = async (/** @type {string} */ dir) => {
      let entries;
      try {
        entries = await this.fsp.readdir(dir, { withFileTypes: true });
      } catch (error) {
        noteIgnored(`list ${what} to import their usage`, error, ['ENOENT']);
        return;
      }
      // a symbolic link is neither a folder nor a file here, so a link that loops is never followed
      for (const e of entries) {
        const p = path.join(dir, String(e.name));
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && match(String(e.name))) out.push(p);
      }
    };
    for (const root of roots) await walk(root);
    return out.sort();
  }
}

module.exports = {
  LedgerImport,
  ImportUnreadable,
  liveSpans,
  addSpans,
  spanKey,
  claudeRequests,
  codexRequests,
  recorded,
  fileLines,
};
