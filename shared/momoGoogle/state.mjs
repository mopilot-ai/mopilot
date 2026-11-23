// What a client says of MoMo's Google source, derived in one place from what the home kept: the typed states the Mac and the phone show (not connected, connecting, connected read-only, send granted, disconnected with its cause), so the two screens never disagree.

/** The words for why a source is disconnected; the screens use their own copy, keyed by these. */
export const DISCONNECT_CAUSES = Object.freeze(['revoked', 'testing_expired', 'scope_missing', 'client_rejected', 'wrong_account']);

/**
 * @typedef {{ kind: 'not_connected', canStart: boolean, iosRedirectUri: string | null }
 *   | { kind: 'connecting' }
 *   | { kind: 'connected_read_only', email: string, connectedAt: number }
 *   | { kind: 'send_granted', email: string, connectedAt: number }
 *   | { kind: 'disconnected', email: string, cause: string, since: number }} GoogleState
 * `canStart`: the home holds a Google client, so a sign-in can begin; `iosRedirectUri`: the redirect the phone's sign-in session uses, when the home also holds an iOS client.
 */

/**
 * @param {object} o
 * @param {import('./types.mjs').AccountStatus} o.status what the home's account says
 * @param {number} o.pending sign-ins begun on the home and not yet finished or expired
 * @param {{ desktop: boolean, iosRedirectUri: string | null }} o.configured which Google clients the home holds
 * @returns {GoogleState}
 */
export function googleStateOf({ status, pending, configured }) {
  if (status.state === 'needs_sign_in') return { kind: 'disconnected', email: status.email, cause: status.cause, since: status.since };
  if (status.state === 'connected')
    return { kind: status.canSend ? 'send_granted' : 'connected_read_only', email: status.email, connectedAt: status.connectedAt };
  if (pending > 0) return { kind: 'connecting' };
  return { kind: 'not_connected', canStart: configured.desktop, iosRedirectUri: configured.iosRedirectUri };
}
