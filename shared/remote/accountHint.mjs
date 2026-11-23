// A non-secret hint of the MoPilot account behind a pairing QR, so the phone can say "different account" at the scan: acct is eight bytes of a hash of the user id, who is the email with its name masked.
const LABEL = 'mopilot-acct-v1:';

/** @param {string} id the MoPilot user id @param {(data: Uint8Array) => Uint8Array} sha256 @returns {string} 16 lowercase hex characters */
export function accountId(id, sha256) {
  const hash = sha256(new TextEncoder().encode(LABEL + id));
  return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {unknown} email @returns {string} "j***@example.com", or '' when it is not an address */
export function maskEmail(email) {
  if (typeof email !== 'string') return '';
  const at = email.lastIndexOf('@');
  return at < 1 || at === email.length - 1 ? '' : `${email[0]}***${email.slice(at)}`;
}

/** The fields the QR adds for a signed-in account: none without a user id. @param {(data: Uint8Array) => Uint8Array} sha256 @param {{ id?: string, email?: string } | null} [user] */
export function accountHint(sha256, user) {
  if (typeof user?.id !== 'string' || !user.id) return {};
  const who = maskEmail(user.email);
  return { acct: accountId(user.id, sha256), ...(who && { who }) };
}
