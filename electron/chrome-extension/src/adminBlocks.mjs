// Administrator URL matching shared by the extension surfaces and main-process enforcement (#1632): the extension's
// managed blockedUrlPatterns, matched as Claude in Chrome matches its own. A pattern names a host and path: `*` is any
// run of characters, letter case is ignored, a leading http(s):// or www. is ignored, and a bare host means every page
// of it (`example.com` is `example.com/*`). A URL is matched the same way (its host and path, without scheme, www.,
// port, query or fragment).
/** At most this many patterns are kept. */
export const MAX_PATTERNS = 500;

const bare = (/** @type {string} */ s) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');

/**
 * The patterns of a policy the extension sent, as matchers; malformed entries are dropped.
 * @param {unknown} policy
 * @returns {{ pattern: string, re: RegExp }[]}
 */
export function adminPatterns(policy) {
  const list = policy && typeof policy === 'object' ? /** @type {any} */ (policy).blockedUrlPatterns : null;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => typeof p === 'string' && bare(p))
    .slice(0, MAX_PATTERNS)
    .map((p) => {
      const b = bare(p);
      const full = b.includes('/') ? b : `${b}/*`;
      const source = full
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return { pattern: p.trim(), re: new RegExp(`^${source}$`, 'i') };
    });
}

/**
 * Why the administrator's policy blocks `url` for MoPilot's agents, or null.
 * @param {{ pattern: string, re: RegExp }[] | undefined} patterns none from a peer that carried no policy @param {string} url
 */
export function adminBlock(patterns, url) {
  if (!patterns?.length) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const target = `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname}`;
  const hit = patterns.find((p) => p.re.test(target));
  return hit ? `This site is blocked for MoPilot's agents by your browser's administrator (${hit.pattern}).` : null;
}
