// Which page addresses the browser's history and bookmarks keep: http(s) pages without credentials in the address, no fragment, bounded in length; and the risk class an agent may see of one.
const { classify } = require('./siteRisk.cjs');

/** Longest address kept; a longer one is data, not a page the user would go back to. */
const MAX_URL = 2048;

/** The address as stored (fragment dropped), or null for anything that is not a plain http(s) page. */
function cleanPageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL * 2) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  u.hash = '';
  const href = u.href;
  return href.length > MAX_URL ? null : href;
}

/**
 * What an agent may be told about a stored address (browser_history_search, browser_bookmarks_search): a blocked
 * address (cloud metadata) is dropped, a high-risk site shows its host only, so account paths, reset links and
 * tokens in a query never reach the model.
 * @returns {{ url: string, risk?: 'high' } | null}
 */
function agentView(url) {
  const risk = classify(url);
  if (risk.level === 'blocked') return null;
  if (risk.level === 'high') return { url: `${new URL(url).origin}/`, risk: 'high' };
  return { url };
}

module.exports = { MAX_URL, cleanPageUrl, agentView };
