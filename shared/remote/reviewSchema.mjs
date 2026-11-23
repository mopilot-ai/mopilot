// Params of the phone's read-only review methods (diff.list, diff.read, file.read), written as a factory over schema.mjs's helpers so the two modules never import each other.

/** The diff scopes of the app's Changes pane: the branch since its base, the working tree, or one turn. */
export const DIFF_SCOPES = Object.freeze(['branch', 'uncommitted', 'turn']);
/** The most characters a path may have, and the rows and bytes one reply may carry (the Mac's own caps apply on top); `from` is the row a page starts at. */
export const MAX_PATH = 1000;
export const MAX_ROWS = 1000;
export const DEFAULT_ROWS = 400;
/** A frame to a phone is at most 256 KB sealed, so a read stays well under it; fewer than 4 bytes could end inside one character and never advance. */
export const MAX_READ = 96 * 1024;
export const DEFAULT_READ = 32 * 1024;
export const MIN_READ = 4;
/** A turn's id as the transcripts name it. */
const TURN = /^[\w.:-]{1,200}$/;

/**
 * @param {{ chatOf: (p: any) => string, bad: (message: string) => Error }} h
 * @returns {Record<string, (p: any) => any>}
 */
export function reviewParsers({ chatOf, bad }) {
  /** A path relative to the folder: text without NUL, not absolute; where it may lead is the Mac's to decide. */
  const pathOf = (/** @type {unknown} */ v) => {
    if (typeof v !== 'string' || !v || v.length > MAX_PATH || v.includes('\0') || v.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(v))
      throw bad('Pick a file in the project folder.');
    return v;
  };
  const intIn = (/** @type {unknown} */ v, /** @type {number} */ min, /** @type {number} */ max, /** @type {number} */ fallback) =>
    Number.isInteger(v) ? Math.max(min, Math.min(max, /** @type {number} */ (v))) : fallback;
  /** The changes a request names: the scope (the working tree unless said), and for a turn which one (its latest unless said). */
  const scopeOf = (/** @type {any} */ p) => {
    const scope = p.scope == null ? 'uncommitted' : p.scope;
    if (!DIFF_SCOPES.includes(scope)) throw bad('Pick which changes to show.');
    if (scope !== 'turn') return { scope };
    if (p.turnId == null) return { scope, turnId: null };
    if (typeof p.turnId !== 'string' || !TURN.test(p.turnId)) throw bad("That turn isn't in this chat.");
    return { scope, turnId: p.turnId };
  };
  return {
    'diff.list': (p) => ({ chatId: chatOf(p), ...scopeOf(p) }),
    'diff.read': (p) => ({
      chatId: chatOf(p),
      ...scopeOf(p),
      path: pathOf(p.path),
      ...(p.oldPath == null ? {} : { oldPath: pathOf(p.oldPath) }),
      from: intIn(p.from, 0, Number.MAX_SAFE_INTEGER, 0),
      rows: intIn(p.rows, 1, MAX_ROWS, DEFAULT_ROWS),
    }),
    'file.read': (p) => ({
      chatId: chatOf(p),
      path: pathOf(p.path),
      offset: intIn(p.offset, 0, Number.MAX_SAFE_INTEGER, 0),
      maxBytes: intIn(p.maxBytes, MIN_READ, MAX_READ, DEFAULT_READ),
    }),
  };
}
