// Reading a chat's folder through the Host (#4103…): the feature both ends declare, the methods it covers, and their parsers. An older Host answers `Unknown method`, and the app says to update it. New read methods (fs.read, git.diff, fs.search) are added here, not to schema.mjs.

/** Declared by a Host that serves the read methods; an end without it is never sent one. */
export const READ_FEATURE = 'hostRead';
/** The read methods: each needs the feature on both ends. */
export const READ_METHODS = Object.freeze(['git.status', 'fs.tree', 'fs.read', 'git.diff', 'fs.search']);
/** The most bytes `fs.read` may be asked for. */
export const MAX_READ_LIMIT = 1_000_000;
/** The longest query and the most paths one `fs.search` may ask for. */
export const MAX_QUERY = 200;
export const MAX_SEARCH = 200;
export const DEFAULT_SEARCH = 50;

/** @param {(v: unknown, what: string) => string} pathOf schema.mjs's absolute-path check @param {(m: string) => Error} bad */
export const readParsers = (pathOf, bad) => ({
  'git.status': (/** @type {any} */ p) => ({ path: pathOf(p.path, 'a folder') }),
  'fs.tree': (/** @type {any} */ p) => ({ path: pathOf(p.path, 'a folder') }),
  'git.diff': (/** @type {any} */ p) => {
    if (p.scope !== 'uncommitted' && p.scope !== 'branch') throw bad('Pick uncommitted or branch changes.');
    return { path: pathOf(p.path, 'a folder'), scope: p.scope };
  },
  'fs.read': (/** @type {any} */ p) => {
    if (p.limit != null && !(Number.isSafeInteger(p.limit) && p.limit >= 1 && p.limit <= MAX_READ_LIMIT))
      throw bad('That is not a size to read.');
    return { path: pathOf(p.path, 'a file'), ...(p.limit == null ? {} : { limit: p.limit }) };
  },
  // a query is text to filter file names by; it is never an argument of a command
  'fs.search': (/** @type {any} */ p) => {
    if (typeof p.query !== 'string' || p.query.length > MAX_QUERY || p.query.includes('\0')) throw bad('Type a shorter search.');
    const limit = p.limit === undefined ? DEFAULT_SEARCH : p.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH) throw bad(`Ask for 1 to ${MAX_SEARCH} results.`);
    return { path: pathOf(p.path, 'a folder'), query: p.query, limit };
  },
});
