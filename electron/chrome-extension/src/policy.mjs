// The administrator's policy for the extension (#1632): chrome.storage.managed's blockedUrlPatterns (managed_schema.json), the sites MoPilot's agents may not use in this Chrome.
//
// It goes to MoPilot with the handshake (client.mjs `auth`), which refuses those sites for every chat and harness
// (adminBlocks.mjs, in main's site table). A change to the policy reconnects, so the new list applies at once.

/** At most this many patterns are passed on. */
export const MAX_PATTERNS = 500;

/**
 * The policy as set, or an empty one: no policy, or managed storage unreadable.
 * @param {any} chrome
 * @returns {Promise<{ blockedUrlPatterns: string[] }>}
 */
export async function readPolicy(chrome) {
  let got;
  try {
    got = await chrome.storage.managed.get('blockedUrlPatterns');
  } catch {
    // no managed storage (an unmanaged browser): no policy
    return { blockedUrlPatterns: [] };
  }
  const list = Array.isArray(got?.blockedUrlPatterns) ? got.blockedUrlPatterns : [];
  return {
    blockedUrlPatterns: list
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim().slice(0, 500))
      .slice(0, MAX_PATTERNS),
  };
}
