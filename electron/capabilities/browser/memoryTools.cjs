// Searches of this Mac's built-in browser history and bookmarks, including URL/secret filtering; their callers enforce the local data owner.
const { ToolError } = require('../contract/registry.cjs');
const { memoryPage } = require('./hostToolArgs.cjs');

function memoryTools(memory) {
  return {
    async browser_history_search(args) {
      if (!memory) throw new ToolError('Browser history is not available.', 'disabled');
      const since = args.since === undefined || args.since === '' ? 0 : Date.parse(String(args.since));
      if (!Number.isFinite(since)) throw new ToolError('since must be an ISO date such as 2026-10-01.', 'bad_args');
      const rows = memory
        .history()
        .search({ query: String(args.query ?? ''), since, limit: args.limit ?? 20 })
        .flatMap((r) => {
          const page = memoryPage(r.url, r.title);
          return page ? [{ ...page, lastVisit: new Date(r.lastVisit).toISOString(), visitCount: r.visitCount }] : [];
        });
      return rows.length ? JSON.stringify(rows) : 'No visited pages match.';
    },

    async browser_bookmarks_search(args) {
      if (!memory) throw new ToolError('Browser bookmarks are not available.', 'disabled');
      const rows = memory
        .bookmarks()
        .search({ query: String(args.query ?? ''), folder: String(args.folder ?? ''), limit: args.limit ?? 50 })
        .flatMap((r) => {
          const page = memoryPage(r.url, r.title);
          return page ? [{ ...page, folderPath: r.folderPath }] : [];
        });
      return rows.length ? JSON.stringify(rows) : 'No bookmarks match.';
    },
  };
}
module.exports = { memoryTools };
