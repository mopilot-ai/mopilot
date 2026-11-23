// MoPilot's Chrome extension protocol (design D5, B2 step 2): the pairing code, the mutual handshake proofs and the protocol constants.
//
// The extension connects to MoPilot on loopback (ws://127.0.0.1:<port>/mopilot-chrome). Both sides know
// one secret from pairing (the code MoPilot hands the extension: `mopilot-chrome:1:<port>:<secret>`), and
// each proves it before the other trusts a single message:
//   app -> extension  { type: 'hello', protocol, nonce: A }
//   extension -> app  { type: 'auth', protocol, nonce: B, proof: HMAC(secret, `mopilot-chrome|extension|A|B`), version }
//   app -> extension  { type: 'welcome', proof: HMAC(secret, `mopilot-chrome|app|B|A`) }
// so another process listening on the port cannot drive Chrome, and another client cannot pose as the extension.
// MoPilot opens the options page with a one-time claim code (`mopilot-claim:1:<port>:<token>`), never the
// secret, since the page's URL is visible to other local processes: the extension trades it for the pairing code
//   extension -> app  { type: 'claim', protocol, token }     app -> extension  { type: 'paired', code }
// on the socket, once. Where MoPilot installed its native messaging host (NATIVE_HOST), the page opens with
// `#pair=host` and the extension asks the host for the claim code instead, so it never appears on a command line.
// Main computes the same proofs with node:crypto (electron/capabilities/browser/chromeExtension.cjs); a unit
// test keeps the two in step.

export const PROTOCOL_NAME = 'mopilot-chrome';
export const PROTOCOL_VERSION = 1;
/** Negotiated exact tab ownership; unrelated to protocol/extension version numbers. */
export const MEMBERSHIP_CAPABILITY = 'tab-membership-v1';
/** Main can admit an exact panel tab before dispatch, instead of treating its URL as context only. */
export const PANEL_TAB_CAPABILITY = 'panel-tab-admission-v1';
export const hasPanelTabCapability = (value) =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'string') &&
  value.filter((entry) => entry === PANEL_TAB_CAPABILITY).length === 1;
/** Malformed or repeated acknowledgements cannot enable exact-membership authority. */
export const hasMembershipCapability = (value) =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === 'string') &&
  value.filter((entry) => entry === MEMBERSHIP_CAPABILITY).length === 1;
/** The native messaging host MoPilot installs (electron/capabilities/browser/chromeNativeHost.cjs HOST_NAME). */
export const NATIVE_HOST = 'ai.mopilot.code.chrome';
/** The path MoPilot serves the extension on. */
export const SOCKET_PATH = '/mopilot-chrome';
const CODE = /^mopilot-chrome:1:(\d{1,5}):([A-Za-z0-9_-]{43})$/;
const CLAIM = /^mopilot-claim:1:(\d{1,5}):([A-Za-z0-9_-]{32})$/;

/**
 * Reads a pairing code; null when it is not one.
 * @param {unknown} code
 * @returns {{ port: number, secret: string } | null}
 */
export function parsePairingCode(code) {
  const m = CODE.exec(String(code ?? '').trim());
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1024 || port > 65535) return null;
  return { port, secret: m[2] };
}

/**
 * Reads a one-time claim code; null when it is not one.
 * @param {unknown} code
 * @returns {{ port: number, token: string } | null}
 */
export function parseClaimCode(code) {
  const m = CLAIM.exec(String(code ?? '').trim());
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1024 || port > 65535) return null;
  return { port, token: m[2] };
}

/**
 * The pairing code for a port and a secret (32 bytes, base64url).
 * @param {number} port @param {string} secret
 */
export function pairingCode(port, secret) {
  return `${PROTOCOL_NAME}:${PROTOCOL_VERSION}:${port}:${secret}`;
}

/** @param {ArrayBuffer | Uint8Array} buf */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * HMAC-SHA256 of `mopilot-chrome|role|a|b` under the secret, as hex.
 * @param {any} crypto WebCrypto (the service worker's, or Node's in tests)
 * @param {string} secret @param {'extension' | 'app'} role @param {string} a @param {string} b
 */
export async function proof(crypto, secret, role, a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${PROTOCOL_NAME}|${role}|${a}|${b}`)));
}

/**
 * A random nonce (16 bytes, hex).
 * @param {any} crypto
 */
export function nonce(crypto) {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Compares two strings in time independent of where they differ.
 * @param {unknown} a @param {unknown} b
 */
export function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
