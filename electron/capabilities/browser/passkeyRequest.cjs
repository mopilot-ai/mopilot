// Decides whether macOS's passkey sheet may serve a built-in browser page's WebAuthn request, and builds the request
// passkeys.node gets. Anything it doesn't serve goes back to the page's own navigator.credentials (Electron's path),
// whose Chromium checks then answer with the spec's error, so this never invents one. The origin comes from main's
// view of the calling frame, never from the page (docs/iab-passkeys.md §4.2).

/** COSE algorithms macOS can make: ES256 for passkeys and keys, EdDSA and RS256 for security keys. */
const ALGORITHMS = new Set([-7, -8, -257]);
const MAX_LIST = 64;
const MAX_BYTES = 1024;
const MAX_TEXT = 1024;
const TIMEOUT = { min: 30_000, max: 600_000, fallback: 300_000 };
const VERIFICATION = new Set(['required', 'preferred', 'discouraged']);
const ATTESTATION = new Set(['none', 'indirect', 'direct', 'enterprise']);
const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'hybrid', 'internal', 'smart-card']);

/** Bytes the page sent as { b64u } (passkeys.cjs encode), or null. */
function bytes(v, max = MAX_BYTES) {
  if (!v || typeof v !== 'object' || typeof v.b64u !== 'string' || !/^[A-Za-z0-9_-]*$/.test(v.b64u)) return null;
  const buf = Buffer.from(v.b64u, 'base64url');
  return buf.length > 0 && buf.length <= max ? buf : null;
}

const text = (v) => (typeof v === 'string' && v.length <= MAX_TEXT ? v : null);
const optional = (v, allowed, fallback) => (v === undefined ? fallback : allowed.has(v) ? v : null);

/** Credential descriptors, or null when any is malformed. */
function descriptors(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_LIST) return null;
  const out = [];
  for (const d of list) {
    const id = d && d.type === 'public-key' ? bytes(d.id) : null;
    const transports = d?.transports === undefined ? [] : d.transports;
    if (!id || !Array.isArray(transports) || transports.length > 8) return null;
    out.push({ id: id.toString('base64'), transports: transports.filter((t) => TRANSPORTS.has(t)) });
  }
  return out;
}

/**
 * The relying party a frame of `origin` may use, or null. A secure origin only (https, or http on localhost); the
 * RP ID must be the origin's host or a registrable suffix of it (the Public Suffix List with private domains, so
 * github.io is a suffix and a.github.io can't claim it). IP hosts, ports, paths and related origins are not served.
 * @param {string} origin
 * @param {unknown} rpId the page's rp.id / rpId, undefined for the default
 */
function relyingParty(origin, rpId) {
  if (!URL.canParse(origin)) return null;
  const url = new URL(origin);
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  // tldts loads with the first passkey request, not with main's startup
  const { getDomain, parse } = require('tldts');
  if (parse(url.hostname).isIp) return null;
  const host = url.hostname;
  if (rpId === undefined) return host;
  if (typeof rpId !== 'string' || !rpId || /[/:?#@\s]/.test(rpId) || !URL.canParse(`https://${rpId}`)) return null;
  const rp = new URL(`https://${rpId}`).hostname;
  // the URL parser lowercases and punycodes; a trailing dot or anything it rewrote beyond that is not served
  if (rp !== rpId.toLowerCase() || rp.endsWith('.')) return null;
  if (host !== rp && !host.endsWith(`.${rp}`)) return null;
  // a localhost RP ID names a local host, which the host check above already required
  if (rp === 'localhost' || rp.endsWith('.localhost')) return rp;
  return getDomain(rp, { allowPrivateDomains: true }) ? rp : null;
}

/** The page's timeout clamped as Chromium does, in ms. */
const timeoutOf = (t) => (typeof t === 'number' && Number.isFinite(t) ? Math.min(TIMEOUT.max, Math.max(TIMEOUT.min, t)) : TIMEOUT.fallback);

/**
 * What passkeys.node gets for one modal request, or null when the system sheet should not serve it.
 * @param {{ kind: unknown, options: any, origin: string, topOrigin?: string | null, caps: { platform: boolean, securityKey: boolean } }} q
 * @returns {{ native: Record<string, unknown>, expect: { type: string, challenge: string, origin: string, rpId: string }, timeout: number } | null}
 */
function nativeRequest({ kind, options, origin, topOrigin = null, caps }) {
  if ((kind !== 'create' && kind !== 'get') || !options || typeof options !== 'object') return null;
  const challenge = bytes(options.challenge);
  const userVerification = optional(
    kind === 'create' ? options.authenticatorSelection?.userVerification : options.userVerification,
    VERIFICATION,
    'preferred',
  );
  const rpId = relyingParty(origin, kind === 'create' ? options.rp?.id : options.rpId);
  if (!challenge || !userVerification || !rpId) return null;
  const base = {
    kind,
    rpId,
    origin,
    topOrigin,
    crossOrigin: false,
    challenge: challenge.toString('base64'),
    userVerification,
  };
  const expect = { type: `webauthn.${kind}`, challenge: challenge.toString('base64url'), origin, rpId };
  const timeout = timeoutOf(options.timeout);
  if (kind === 'get') {
    const allow = descriptors(options.allowCredentials);
    if (!allow) return null;
    const native = { ...base, allow, platform: caps.platform, hybrid: caps.platform, securityKey: caps.securityKey };
    return native.platform || native.securityKey ? { native, expect, timeout } : null;
  }
  const user = options.user;
  const userId = bytes(user?.id, 64);
  const name = text(user?.name);
  const displayName = user?.displayName === undefined ? name : text(user.displayName);
  const exclude = descriptors(options.excludeCredentials);
  const params = options.pubKeyCredParams;
  const attestation = optional(options.attestation, ATTESTATION, 'none');
  const selection = options.authenticatorSelection ?? {};
  if (!userId || name === null || displayName === null || !exclude || !attestation || typeof selection !== 'object') return null;
  if (!Array.isArray(params) || params.length > 32 || params.some((p) => p?.type !== 'public-key' || !Number.isInteger(p.alg))) return null;
  const algorithms = (params.length ? params.map((p) => p.alg) : [-7, -257]).filter((a) => ALGORITHMS.has(a));
  const attachment = selection.authenticatorAttachment;
  const residentKey = selection.residentKey ?? (selection.requireResidentKey === true ? 'required' : 'discouraged');
  if (!['required', 'preferred', 'discouraged'].includes(residentKey)) return null;
  // a passkey on this Mac or a phone is ES256 only; a security key takes the page's list
  const platform = caps.platform && attachment !== 'cross-platform' && algorithms.includes(-7);
  const securityKey = caps.securityKey && attachment !== 'platform' && algorithms.length > 0;
  if (!platform && !securityKey) return null;
  const native = {
    ...base,
    userId: userId.toString('base64'),
    name,
    displayName,
    exclude,
    algorithms,
    attestation,
    residentKey,
    platform,
    hybrid: platform,
    securityKey,
  };
  return { native, expect, timeout };
}

module.exports = { nativeRequest, relyingParty, timeoutOf, TIMEOUT };
