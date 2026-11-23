// The address bar's suggestions: bookmarks that match first, then visited pages, one row per address.

/**
 * @param {{ bookmarks: { search(o: any): any[] }, history: { search(o: any): any[] } }} stores
 * @param {string} text what the user typed
 * @param {number} [limit]
 * @returns {{ kind: 'bookmark' | 'history', url: string, title: string }[]}
 */
function suggest({ bookmarks, history }, text, limit = 6) {
  const typed = String(text ?? '').trim();
  if (!typed) return [];
  /** @type {{ kind: 'bookmark' | 'history', url: string, title: string }[]} */
  const out = [];
  const seen = new Set();
  const push = (kind, rows) => {
    for (const r of rows) {
      if (out.length >= limit) return;
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push({ kind, url: r.url, title: r.title });
    }
  };
  push('bookmark', bookmarks.search({ query: typed, limit, distinctUrls: true }));
  push('history', history.search({ query: typed, limit }));
  return out;
}

module.exports = { suggest };
