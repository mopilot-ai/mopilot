// The request ledger's one line (schema v1): only typed ids, model names, counts and an outcome are copied from a
// record, and the harness's error text is scrubbed of keys, tokens and user paths and cut short. Nothing else a tap
// passes in can reach the file, so no prompt, reply or tool content is ever written.
const { scrub } = require('../../shared/scrub.cjs');

const OUTCOMES = new Set(['ok', 'retry', 'error', 'interrupted']);
/** How a request is paid for: a subscription plan, the user's API key, MoPilot credits, a cloud provider, the user's own provider through MoPilot's model router, or not known. */
const PAYS = new Set(['plan', 'key', 'gateway', 'cloud', 'routed', 'unknown']);
/** How much of a harness's error text a line keeps. */
const ERROR_MAX = 300;
/** Ids and model names are short; anything longer is not one. */
const ID_MAX = 200;

const id = (v) => (typeof v === 'string' && v && v.length <= ID_MAX ? v : undefined);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/** @param {unknown} text @param {string} [home] */
function errorText(text, home) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const s = scrub(text.replace(/\s+/g, ' ').trim(), { home });
  return s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX).replace(/[\uD800-\uDBFF]$/, '')}…` : s;
}

/**
 * @typedef {'plan' | 'key' | 'gateway' | 'cloud' | 'routed' | 'unknown'} LedgerPay
 * @typedef {{ id?: string, email?: string | null, verified?: boolean | null, pay?: LedgerPay }} LedgerAccount `pay` is how
 *   the account bills; it is written as the line's own `pay`, never inside `account`
 * @typedef {{ kind?: 'computerAccess', device?: string, tool?: string, key?: string, pay?: LedgerPay,
 *   chat?: string, harness?: string, session?: string, turn?: string, account?: LedgerAccount | null,
 *   req?: string, served?: string, effort?: string, in?: number, out?: number, cacheRead?: number, cacheWrite?: number,
 *   reasoning?: number, outcome: 'ok' | 'retry' | 'error' | 'interrupted', status?: number, code?: string, error?: string }} LedgerRecord
 */

/**
 * The line written for `r` at `now`, or null when `r` names no harness or no known outcome.
 * @param {LedgerRecord} r @param {number} now @param {{ home?: string }} [o]
 */
function ledgerLine(r, now, o = {}) {
  if (!r || !id(r.harness) || !OUTCOMES.has(r.outcome)) return null;
  const a = r.account;
  const account =
    a && id(a.id)
      ? {
          id: a.id,
          ...(id(a.email ?? undefined) ? { email: a.email } : {}),
          ...(typeof a.verified === 'boolean' ? { verified: a.verified } : {}),
        }
      : undefined;
  const line = {
    v: 1,
    t: new Date(now).toISOString(),
    // a call a paired device made on this Mac (computer access, #1364): which device and which tool, never its content
    kind: r.kind === 'computerAccess' ? r.kind : undefined,
    device: r.kind === 'computerAccess' ? id(r.device) : undefined,
    tool: r.kind === 'computerAccess' ? id(r.tool) : undefined,
    chat: id(r.chat),
    harness: r.harness,
    session: id(r.session),
    turn: id(r.turn),
    // the request's own id, the same one the harness's transcript keeps, so a request is counted once wherever it is read
    key: id(r.key),
    account,
    pay: PAYS.has(/** @type {string} */ (r.pay)) ? r.pay : undefined,
    req: id(r.req),
    served: id(r.served),
    effort: id(r.effort),
    in: count(r.in),
    out: count(r.out),
    cacheRead: count(r.cacheRead),
    cacheWrite: count(r.cacheWrite),
    reasoning: count(r.reasoning),
    outcome: r.outcome,
    status: count(r.status),
    code: r.outcome === 'ok' ? undefined : id(r.code),
    error: r.outcome === 'ok' ? undefined : errorText(r.error, o.home),
  };
  // JSON.stringify leaves out the fields that came out undefined
  return JSON.stringify(line);
}

module.exports = { ledgerLine, errorText, ERROR_MAX, PAYS };
