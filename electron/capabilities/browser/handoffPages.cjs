// The sites MoPilot handed to the user's Chrome for a sign-in, per chat (browser/handoff.cjs). A Claude in Chrome
// group holding such a page is the user's sign-in, not a page the chat keeps working in, so it does not keep an idle
// Claude Code CLI alive past the usual idle time (harness/claude/chromeTabs.cjs holdsPages, #1403).

const { isIdentityProvider } = require('../../../shared/browser.mjs');

/** Hand-off origins kept per chat: a chat hands off a few sites at most, and old ones go first. */
const PER_CHAT = 20;
/** @type {Map<string, string[]>} chat id → origins handed off, oldest first */
const byChat = new Map();

/** The origin of a web URL, or null. @param {unknown} url */
function originOf(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    // not a URL: nothing to match
    return null;
  }
}

/** Record that `url`'s site was handed to the user's Chrome for chat `chatId`. @param {string} chatId @param {string} url */
function noteHandoff(chatId, url) {
  const origin = originOf(url);
  if (!chatId || !origin) return;
  const list = (byChat.get(chatId) ?? []).filter((o) => o !== origin);
  list.push(origin);
  byChat.set(chatId, list.slice(-PER_CHAT));
}

/**
 * Whether a tab at `url` is on a site handed to the user's Chrome for chat `chatId` (a sign-in moves within its site,
 * so the origin is what matches), or on an identity provider while that chat has a hand-off (the sign-in passes
 * through it). @param {string | undefined} chatId @param {string} url
 */
function handedOff(chatId, url) {
  const origin = originOf(url);
  const sites = (chatId && byChat.get(chatId)) || [];
  return !!origin && sites.length > 0 && (sites.includes(origin) || isIdentityProvider(url));
}

/** Forget a chat's hand-offs (the chat was archived or cleared). @param {string} chatId */
function forgetHandoffs(chatId) {
  byChat.delete(chatId);
}

module.exports = { noteHandoff, handedOff, forgetHandoffs };
