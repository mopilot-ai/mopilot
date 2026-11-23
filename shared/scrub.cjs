// Redacts secrets and personal identifiers from text before it is uploaded (desktop) and again
// before it is stored (web). Patterns err on the side of redacting.
'use strict';

const R = (label) => `[REDACTED:${label}]`;

/** [pattern, replacement] in order; earlier, more specific rules run first. */
const RULES = [
  // Computer History memories a user shared with a chat (shared/computerHistory.mjs, #1363) never leave in a report
  [/<sage-computer-history>[\s\S]*?(?:<\/sage-computer-history>|$)/g, R('computer-history')],
  // and so does MoMo's memory of the user (shared/momoContext.mjs, #2139)
  [/<momo-context>[\s\S]*?(?:<\/momo-context>|$)/g, R('momo-context')],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, R('private-key')],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R('jwt')],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, R('anthropic-key')],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, R('openai-key')],
  [/\bmp(?:k|rt)_[A-Za-z0-9_-]{16,}/g, R('mopilot-key')],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, R('aws-key-id')],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, R('github-token')],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R('slack-token')],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, R('stripe-key')],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, R('stripe-webhook-secret')],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R('google-key')],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, R('npm-token')],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_m, kind) => `${kind} ${R('token')}`],
  // scheme://user:password@host
  // Runs a match may start inside are bounded (a scheme, the rest of a key name, an address's local part), and a key
  // name's start is left out of the match (it stays as it is): an unbounded run is retried from every position of a
  // long run of such characters (a base64 blob in a transcript), quadratic time.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s:@/]+:[^\s@/]+@/gi, (_m, scheme) => `${scheme}${R('credentials')}@`],
  // KEY=value / "secret": "value" / password: value (env files, JSON, YAML)
  [
    /(["']?(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]{0,256}\b["']?\s*[:=]\s*)(["']?)(?!Bearer\b|Basic\b|\[REDACTED|<email>)([^\s"',;}]{6,})\2/gi,
    (_m, lhs, q) => `${lhs}${q}${R('secret')}${q}`,
  ],
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}\b/g, '<email>'],
];

/**
 * @param {string} text
 * @param {{ home?: string }} [opts] home directory to replace with "~"
 */
function scrub(text, opts = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  if (opts.home && opts.home.length > 1) out = out.split(opts.home).join('~');
  out = out.replace(/\/Users\/[^/\s"']+/g, '/Users/<user>').replace(/\/home\/[^/\s"']+/g, '/home/<user>');
  // Windows: C:\Users\name in any drive letter and case, and with JSON's or a debug print's doubled backslashes
  out = out.replace(/\b([A-Za-z]:\\{1,2})Users(\\{1,2})[^\\/\s"']+/gi, (_m, drive, sep) => `${drive}Users${sep}<user>`);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

/** Scrub every string inside a JSON-like value; truncate strings longer than `max`. */
function scrubDeep(value, opts = {}, max = 32 * 1024) {
  if (typeof value === 'string') {
    const s = scrub(value, opts);
    return s.length > max ? `${s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')}…[truncated ${s.length - max} chars]` : s;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, opts, max));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = scrubDeep(v, opts, max);
    return o;
  }
  return value;
}

const SECRET_ENV =
  /(?:secret|token(?!s)|passw(?:or)?d|api[_-]?key|auth|credential|private[_-]?key)|^ANTHROPIC_(?:BASE_URL|CUSTOM_HEADERS)$/i;

/** A copy of an environment that is safe to print in diagnostics: secret-looking values are redacted, the rest scrubbed. */
function redactEnv(env, opts = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = v == null ? v : SECRET_ENV.test(k) ? R('secret') : scrub(String(v), opts);
  return out;
}

module.exports = { scrub, scrubDeep, redactEnv };
