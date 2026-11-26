// The Host's audit record on the wire and on disk (plan W3): the kinds of line, the fields a line may carry (metadata only), the hash chain and its check, and the `host.auditRead` parser. Shared by the Host's writer, its CLI export and the app's "Activity on this machine" view.
import { createHash } from 'node:crypto';

/** Declared by a Host that keeps an audit record; an app without it is never sent `host.auditRead`. */
export const AUDIT_FEATURE = 'audit';
export const AUDIT_READ_METHOD = 'host.auditRead';
/** The refusal when `audit.required` is set and a governed action's line could not be written. */
export const AUDIT_UNAVAILABLE = 'audit_unavailable';
export const AUDIT_KINDS = Object.freeze([
  'chat.started',
  'chat.message',
  'approval.asked',
  'approval.answered',
  'approval.expired',
  'permission.set',
  'tool.relayed',
  'credential.lent',
  'credential.expired',
  'client.added',
  'client.removed',
  'controller.connected',
  'client.refused',
  'code.offered',
  'code.refused',
  'code.reset',
  'link.retired',
  'link.forgotten',
  'lease.handed',
  'lease.floor',
  'lease.repaired',
  'policy.changed',
  'schedule.run',
  'git.write',
]);
/** The only keys of a line's `what`, each a short scalar: no text, command or path ever fits. `summary` is kept only when the managed policy sets `audit.detail` to `full`. */
export const WHAT_KEYS = Object.freeze([
  'tool',
  'decision',
  'waitedMs',
  'status',
  'mode',
  'key',
  'cardKind',
  'outcome',
  'code',
  'generation',
  'kind',
  'taskId',
  'harness',
  'count',
  'addedBy',
  'succeeds',
  'summary',
]);
export const SUMMARY_MAX = 160;
const SCALAR_MAX = 64;
export const DEFAULT_RETENTION_DAYS = 90;
export const READ_LIMIT_MAX = 500;

/** The metadata of one line, cut down to the allowed keys and bounded scalars. @param {Record<string, unknown> | undefined} what @param {boolean} full whether `audit.detail` is `full` */
export function whatOf(what, full) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const k of WHAT_KEYS) {
    const v = what?.[k];
    if (k === 'summary') {
      if (full && typeof v === 'string') out.summary = v.slice(0, SUMMARY_MAX);
    } else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, SCALAR_MAX);
  }
  return out;
}

/** The hash a line's successor carries: SHA-256 of its exact text. @param {string} text */
export const hashLine = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Checks a run of lines in order: each `prev` must be the hash of the line before it. A line that opens a new segment (`segment` set) restarts the chain, so a corrupt day file is marked, never hidden.
 * @param {string[]} texts the lines as written
 * @returns {{ ok: boolean, brokenAt: number | null }} the index of the first line that does not follow
 */
export function verifyChain(texts) {
  let prev = /** @type {string | null} */ (null);
  for (let i = 0; i < texts.length; i++) {
    /** @type {any} */
    let line;
    try {
      line = JSON.parse(texts[i]);
    } catch {
      return { ok: false, brokenAt: i };
    }
    if (i > 0 && !line.segment && line.prev !== prev) return { ok: false, brokenAt: i };
    prev = hashLine(texts[i]);
  }
  return { ok: true, brokenAt: null };
}

/** The wire parser for `host.auditRead { after, limit }`. @param {(m: string) => Error} bad */
export const auditParsers = (bad) => ({
  [AUDIT_READ_METHOD]: (/** @type {any} */ p) => {
    if (p.after != null && !(Number.isSafeInteger(p.after) && p.after >= 0)) throw bad('That is not a place in the record.');
    if (p.limit != null && !(Number.isSafeInteger(p.limit) && p.limit >= 1 && p.limit <= READ_LIMIT_MAX))
      throw bad(`Ask for 1 to ${READ_LIMIT_MAX} lines.`);
    return { after: p.after ?? 0, limit: p.limit ?? 100 };
  },
});
