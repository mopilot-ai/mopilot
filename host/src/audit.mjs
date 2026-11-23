// The Host's audit record (plan W3): one metadata-only, hash-chained line per decision the Host makes or enforces, in daily files (0600, append-only, one writer per process). With `audit.required` a governed action runs only after its line was written; a write failure refuses it with `audit_unavailable` and the next action tries again.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_UNAVAILABLE, DEFAULT_RETENTION_DAYS, hashLine, whatOf } from '../../shared/host/audit.mjs';
import { HostRefusal } from './hostFs.mjs';

const DAY = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;
const short = (/** @type {unknown} */ v, max = 64) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

/**
 * @param {object} o
 * @param {string} o.dir where the day files live (`<data dir>/audit`)
 * @param {() => { required?: boolean, detail?: string, retentionDays?: number }} [o.settings] `audit.required`, `audit.detail`, `audit.retentionDays` from the managed layer only
 * @param {() => string} [o.generation] the effective policy generation a line names
 * @param {() => number} [o.now]
 * @param {(m: string) => void} [o.report]
 * @param {Pick<typeof fs, 'appendFileSync' | 'mkdirSync' | 'readdirSync' | 'readFileSync' | 'unlinkSync'>} [o.io]
 */
export function createAudit({ dir, settings = () => ({}), generation = () => '', now = Date.now, report = () => undefined, io = fs }) {
  /** @type {{ seq: number, prev: string | null, repair: boolean } | null} */
  let chain = null;
  let lastDay = '';
  let reported = false;
  const dayOf = (/** @type {number} */ at) => new Date(at).toISOString().slice(0, 10);
  const days = () => {
    try {
      return io
        .readdirSync(dir)
        .filter((n) => DAY.test(n))
        .sort();
    } catch {
      return [];
    }
  };
  const textsOf = (/** @type {string} */ name) => {
    try {
      return String(io.readFileSync(path.join(dir, name), 'utf8'))
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  /** Resumes the chain from the newest line on disk; a last line that does not parse starts a marked segment. */
  function resume() {
    for (const name of days().reverse()) {
      const texts = textsOf(name);
      const last = texts.at(-1);
      if (last === undefined) continue;
      try {
        return { seq: JSON.parse(last).seq, prev: hashLine(last), repair: false };
      } catch {
        const seq = texts.slice(0, -1).reduce((s, t) => {
          try {
            return Math.max(s, JSON.parse(t).seq);
          } catch {
            return s;
          }
        }, 0);
        return { seq, prev: null, repair: true };
      }
    }
    return { seq: 0, prev: null, repair: false };
  }

  /** Deletes the day files older than the retention. @param {number} at */
  function prune(at) {
    const keep = settings().retentionDays ?? DEFAULT_RETENTION_DAYS;
    const oldest = dayOf(at - keep * DAY_MS);
    for (const name of days()) {
      if (name.slice(0, 10) >= oldest) break;
      try {
        io.unlinkSync(path.join(dir, name));
      } catch {
        report('audit: an old day file could not be removed.');
      }
    }
  }

  /**
   * @param {{ kind: string, chat?: string, turn?: string, harness?: string, by?: { fingerprint?: string, name?: string, kind?: string } | null, org?: string, what?: Record<string, unknown> }} entry
   * @returns {string} the line written
   */
  /** What a line may not carry (the ids of chats a feature keeps apart) is taken out of an entry before it is written: set by `redactWith`. @type {(e: any) => any} */
  let redact = (e) => e;
  function append(entry) {
    const e = redact(entry);
    chain ??= resume();
    const at = now();
    const full = settings().detail === 'full';
    const by = e.by ? { fingerprint: short(e.by.fingerprint, 64), name: short(e.by.name, 80), kind: short(e.by.kind, 16) } : undefined;
    const marked = chain.repair ? { segment: 'recovered' } : {};
    const line = {
      seq: chain.seq + 1,
      prev: chain.repair ? null : chain.prev,
      at,
      kind: e.kind,
      ...(short(e.chat, 128) ? { chat: short(e.chat, 128) } : {}),
      ...(short(e.turn, 128) ? { turn: short(e.turn, 128) } : {}),
      ...(short(e.harness) ? { harness: short(e.harness) } : {}),
      ...(by ? { by } : {}),
      ...(short(e.org, 128) ? { org: short(e.org, 128) } : {}),
      what: whatOf(e.what, full),
      policy: generation(),
      ...marked,
    };
    const text = JSON.stringify(line);
    io.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // a write that failed half-way may have left a line with no end: the next one starts on its own line
    io.appendFileSync(path.join(dir, `${dayOf(at)}.jsonl`), `${chain.repair ? '\n' : ''}${text}\n`, { mode: 0o600 });
    chain = { seq: line.seq, prev: hashLine(text), repair: false };
    if (dayOf(at) !== lastDay) {
      lastDay = dayOf(at);
      prune(at);
    }
    return text;
  }

  /** A write that failed: the chain is marked, so the next line says it follows a gap. */
  function failed(/** @type {unknown} */ error) {
    chain ??= { seq: 0, prev: null, repair: true };
    chain.repair = true;
    if (!reported) report(`audit: a line could not be written (${String(error)}).`);
    reported = true;
  }

  return {
    /** From now on every entry passes `fn` before it is written. @param {(e: any) => any} fn */
    redactWith(fn) {
      redact = fn;
    },
    /** A governed decision: with `audit.required` a failed write refuses it; without, it is reported once and the action goes on. @param {Parameters<typeof append>[0]} e @returns {boolean} whether the line is on disk */
    governed(e) {
      try {
        append(e);
        reported = false;
        return true;
      } catch (error) {
        failed(error);
        if (settings().required) throw new HostRefusal(AUDIT_UNAVAILABLE, 'This machine could not record the action, so it was not done.');
        return false;
      }
    },
    /** A decision that is not the action's own gate (an expiry, a relayed call): a failure is reported, never thrown. @param {Parameters<typeof append>[0]} e */
    note(e) {
      try {
        append(e);
        reported = false;
      } catch (error) {
        failed(error);
      }
    },
    /** The lines after sequence `after`, oldest first, at most `limit`; a line that does not parse is left out. @param {{ after?: number, limit?: number }} [q] @returns {{ lines: any[], next: number }} */
    read({ after = 0, limit = 100 } = {}) {
      /** @type {any[]} */
      const lines = [];
      for (const name of days()) {
        for (const t of textsOf(name)) {
          try {
            const l = JSON.parse(t);
            if (l.seq > after) lines.push(l);
          } catch {
            // a corrupt line is not served
          }
          if (lines.length >= limit) return { lines, next: lines.at(-1).seq };
        }
      }
      return { lines, next: lines.at(-1)?.seq ?? after };
    },
    /** Every line from the day of `since` (ms) on, as written, for the CLI. @param {number} [since] */
    exportText(since = 0) {
      const from = dayOf(since);
      return days()
        .filter((n) => n.slice(0, 10) >= from)
        .flatMap(textsOf)
        .filter((t) => {
          try {
            return JSON.parse(t).at >= since;
          } catch {
            return false;
          }
        });
    },
  };
}
