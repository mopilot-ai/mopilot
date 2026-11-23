// What Remote Control tells a session's user and how it reads a failure or a link (electron/harness/claude/remoteControl.cjs): the
// words it shows, the patterns that tell a sign-in, a lost network or a passing server trouble from a refusal, and the check that
// an SDK answer is a usable claude.ai link. Pure, so it needs no session.

const AUTH = /\b(auth|authenticat|sign.?in|log.?in|login|oauth|token|credential|expired|unauthori[sz]ed|401|403)/i;
const NETWORK = /(network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|offline)/i;
/** A failure that is the server's or ours being slow, not a refusal: a connect that timed out, a 5xx. */
const TRANSIENT =
  /(did not connect in time|(^|\b(http|status|code|error)\W{0,3})5\d\d\b|overloaded|bad gateway|service unavailable|temporarily unavailable)/i;
const OFFLINE = 'Offline: reconnecting when the network is back';
const RECONNECTING = 'Reconnecting Remote Control';
const UNAVAILABLE = "Remote Control isn't available for this login. It needs a claude.ai subscription that your organization allows.";

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** An error as the chat shows it: short, and without a link or bridge id an SDK message may carry (those are the user's, not the model's or a log's). */
const text = (e) =>
  String(e?.message || e || 'failed')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\bcse_\w+/g, '[id]')
    .slice(0, 200);

/** An https page of claude.ai or claude.com: the only place a Remote Control link may point. */
function claudeUrl(text) {
  try {
    const u = new URL(text);
    return u.protocol === 'https:' && /(^|\.)claude\.(ai|com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * What the SDK answered to a connect, or null when it is not a usable link (a missing or non-string field is no link).
 * @param {unknown} r
 */
function linkOf(r) {
  const x = /** @type {any} */ (r);
  return isRecord(x) && typeof x.session_url === 'string' && claudeUrl(x.session_url) && typeof x.bridge_session_id === 'string'
    ? { url: x.session_url, bridge: x.bridge_session_id }
    : null;
}

module.exports = { AUTH, NETWORK, TRANSIENT, OFFLINE, RECONNECTING, UNAVAILABLE, isRecord, text, linkOf };
