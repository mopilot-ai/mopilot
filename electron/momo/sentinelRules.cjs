// The rules MoMo's sentinel decides by (#2139): access levels and approval scopes, a call's destinations (lower-cased; a shape that can't be read is an unknown destination, which always asks), the fingerprint of the exact action it names, and a remembered approval read back from storage checked before it counts.
const crypto = require('node:crypto');
const { canonical } = require('./canonical.cjs');

const LEVELS = Object.freeze({ BLOCKED: 'blocked', READ: 'read', ASK: 'ask' });
const LEVEL_SET = new Set(Object.values(LEVELS));
// SITE: "Always allow <host>" on a navigation's card (sentinelSites.cjs), kept as a site, never as a grant
const SCOPES = Object.freeze({ ONCE: 'once', CHAT: 'chat', TODAY: 'today', DAYS30: '30d', SITE: 'site' });
const SCOPE_SET = new Set(Object.values(SCOPES));
const KINDS = new Set(['read', 'change']);
const DAY = 24 * 60 * 60 * 1000;
/** No remembered approval lasts longer. */
const MAX_REMEMBER = 30 * DAY;
const MAX_TEXT = 200;

/**
 * @typedef {'blocked' | 'read' | 'ask'} Level
 * @typedef {{ level: Level, private?: boolean, name?: string }} Source
 * @typedef {{ hosts?: string[], recipients?: string[], unknown?: boolean }} Egress where a call sends data; unknown: it can't be told
 * @typedef {{ chatId: string, tool: string, source: string, kind: 'read' | 'change', args?: unknown, account?: string, harness?: string,
 *             egress?: Egress, summary?: string, repeatable?: boolean, sandbox?: boolean, opens?: string, reaches?: boolean }} Call
 *   sandbox: a change that only writes inside MoMo's own folder (with repeatable), decided without a card
 *   reaches: a change that can reach people (recipients.cjs); with no readable recipient it is blocked, never allowed
 *   opens: the address a navigation opens (toolTrust.cjs), which may make it openable without a card (sentinelSites.cjs)
 * @typedef {{ id: string, effect: 'allow' | 'deny', fingerprint: string, scope: string, chatId?: string, expiresAt?: number,
 *             createdAt: number, tool: string, source: string, account: string, summary: string }} Grant
 * @typedef {{ chatId: string, tool: string, source: string, account: string, kind: string, summary: string,
 *             destinations: { hosts: string[], recipients: string[], unknown: boolean },
 *             reasons: string[], scopes: string[], denyAlways: boolean, opens?: boolean }} Card
 * @typedef {{ allow: true, scope: string, by?: string } | { allow: false, always?: boolean, by?: string }} Answer
 * @typedef {{ allow: true, via: 'read' | 'remembered' | 'asked' | 'site' | 'sandbox', scope?: string, grantId?: string, persisted?: boolean, fingerprint: string, by?: string }
 *         | { allow: false, reason: string, fingerprint: string | null, by?: string }} Decision
 * @typedef {{ v: 1, grants: Grant[], sites?: string[], taint?: Record<string, string[]>, runs?: Record<string, Record<string, { running: number, uncertain: number }>>, opened?: Record<string, string[]> }} Stored
 * @typedef {{ read(): Promise<unknown>, write(data: Stored): Promise<void>, setAside?: () => Promise<string> }} Storage
 *   read: null when there is nothing yet, throws when it can't be read; setAside: keeps an unreadable store aside (the user's choice)
 */

const isRecord = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
const shortText = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;

/**
 * The destinations of `egress`, normalized, without repeats and sorted; a shape that can't be read, or a host that can't be
 * parsed, counts as an unknown destination, which always asks.
 */
function destinationsOf(/** @type {unknown} */ egress) {
  if (egress === undefined) return { hosts: [], recipients: [], unknown: false };
  const list = (/** @type {unknown} */ v, /** @type {(s: string) => string | null} */ norm) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) return null;
    const out = v.map(norm);
    return out.every((x) => x) ? [...new Set(/** @type {string[]} */ (out))].sort() : null;
  };
  const e = /** @type {Record<string, unknown>} */ (isRecord(egress) ? egress : {});
  const hosts = list(e.hosts, normHost);
  const recipients = list(e.recipients, normRecipient);
  if (!isRecord(egress) || !hosts || !recipients) return { hosts: [], recipients: [], unknown: true };
  return { hosts, recipients, unknown: e.unknown === true };
}
/** A host's name as the allow list compares it: from a bare host or a URL, without scheme, port, path or a trailing dot, lower-cased and in its ASCII (punycode) form; null when it is not a host. */
function normHost(/** @type {string} */ h) {
  const text = h.trim();
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname;
  } catch {
    // not a host: an unknown destination
    return null;
  }
  return host.replace(/\.$/, '') || null;
}
const normRecipient = (/** @type {string} */ r) => r.trim().toLowerCase() || null;

/** The exact action a call names: the same tool, source, account, kind, arguments and destinations, however the arguments were written. */
function fingerprintOf(/** @type {Call} */ call) {
  const text = canonical({
    tool: call.tool,
    source: call.source,
    account: call.account ?? '',
    kind: call.kind,
    args: call.args ?? null,
    egress: destinationsOf(call.egress),
  });
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** When an approval given at `now` for `scope` ends: tonight for today; this chat and 30 days both end within 30 days. */
function expiryOf(/** @type {string} */ scope, /** @type {number} */ now) {
  if (scope !== SCOPES.TODAY) return now + MAX_REMEMBER;
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** A grant read back from storage, or null when it is not one. */
function grantOf(/** @type {unknown} */ g) {
  if (!isRecord(g)) return null;
  const r = /** @type {Record<string, any>} */ (g);
  const timed = (/** @type {unknown} */ v) => v === undefined || Number.isFinite(v);
  if (!shortText(r.id) || !/^[0-9a-f]{64}$/.test(r.fingerprint) || !Number.isFinite(r.createdAt) || !timed(r.expiresAt)) return null;
  if (
    r.effect === 'deny'
      ? r.scope !== 'always'
      : r.effect !== 'allow' || !SCOPE_SET.has(r.scope) || r.scope === SCOPES.ONCE || r.scope === SCOPES.SITE
  )
    return null;
  if (r.effect === 'allow' && (r.expiresAt === undefined || r.expiresAt - r.createdAt > MAX_REMEMBER)) return null;
  if (r.scope === SCOPES.CHAT && !shortText(r.chatId)) return null;
  return /** @type {Grant} */ ({ ...r });
}

/**
 * A call that may run again while one runs or after one ended uncertain (#2283): a browser or computer-use act or
 * navigation, which a retry repeats on screen. Never a change, except one inside MoMo's own folder (sandbox): any other change's repeat is refused until the user says yes.
 */
const repeatable = (/** @type {Call} */ call) => call.repeatable === true && (call.kind !== 'change' || call.sandbox === true);

/** The source MoMo's own folder is known by; only a call from it can be a sandbox change. */
const SANDBOX_SOURCE = 'outputs';

/** A change that only writes inside MoMo's own folder: from the outputs source, flagged `sandbox` and `repeatable`, and sending nothing anywhere. */
const isSandbox = (/** @type {Call} */ call, /** @type {ReturnType<typeof destinationsOf>} */ dest) =>
  call.kind === 'change' &&
  call.source === SANDBOX_SOURCE &&
  call.sandbox === true &&
  call.repeatable === true &&
  !dest.unknown &&
  !dest.hosts.length &&
  !dest.recipients.length;

module.exports = {
  isSandbox,
  SANDBOX_SOURCE,
  repeatable,
  LEVELS,
  LEVEL_SET,
  SCOPES,
  KINDS,
  MAX_REMEMBER,
  MAX_TEXT,
  isRecord,
  shortText,
  destinationsOf,
  normHost,
  normRecipient,
  fingerprintOf,
  grantOf,
  expiryOf,
};
