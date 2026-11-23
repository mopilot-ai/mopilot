// Canonical GitHub pull-request identities shared by the monitor and imported chat attachments.
export function pullRequestUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null;
    if (!/^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)) return null;
    return `https://github.com${url.pathname.replace(/\/$/, '').toLowerCase()}`;
  } catch {
    return null;
  }
}

const FORMER_MOPILOT_PRS = 'https://github.com/mopilot-ai/mopilot/pull/';
const INTERNAL_MOPILOT_PRS = 'https://github.com/mopilot-ai/mopilot-internal/pull/';
// GitHub's creation times for the original repository and the one that took its name (#5425).
const ORIGINAL_MOPILOT_CREATED_AT = Date.parse('2026-10-09T02:14:38Z');
const MOPILOT_NAME_REUSED_AT = Date.parse('2026-11-21T23:34:53Z');

/** Whether the original repository still owned the old name when the link was recorded.
 * @param {number | null} [recordedAt] the reference's timestamp in epoch seconds (Codex) or milliseconds
 */
export function recordedBeforeMopilotReuse(recordedAt) {
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return false;
  const at = recordedAt < 1e12 ? recordedAt * 1_000 : recordedAt;
  return at >= ORIGINAL_MOPILOT_CREATED_AT && at < MOPILOT_NAME_REUSED_AT;
}

/** The historical counterpart of a canonical URL. Callers must establish that the reference names the old PR.
 * @param {string} url
 */
export function movedMopilotPullRequestUrl(url) {
  return url.startsWith(FORMER_MOPILOT_PRS) ? INTERNAL_MOPILOT_PRS + url.slice(FORMER_MOPILOT_PRS.length) : url;
}

/** @param {string} url */
export function isMopilotPullRequestUrl(url) {
  return url.startsWith(FORMER_MOPILOT_PRS) || url.startsWith(INTERNAL_MOPILOT_PRS);
}

/** Resolve a canonical link recorded in a reply or attachment. An undated or current link names today's repository.
 * @param {string} url
 * @param {number | null} [recordedAt]
 */
export function historicalPullRequestUrl(url, recordedAt) {
  return recordedBeforeMopilotReuse(recordedAt) ? movedMopilotPullRequestUrl(url) : url;
}
