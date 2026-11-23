// Changing a chat's folder through the Host, the writes of the Changes pane (#5050): commit and discard. The feature both ends declare, the two methods and their parsers. An older Host answers `Unknown method` or `feature_missing`, and the app says to update it.

/** Declared by a Host that serves the git write methods; an end without it is never sent one. */
export const GIT_WRITE_FEATURE = 'gitWrite';
export const GIT_COMMIT_METHOD = 'host.gitCommit';
export const GIT_DISCARD_METHOD = 'host.gitDiscard';
/** The most files one commit may name, and the longest message and path. */
export const MAX_COMMIT_FILES = 5000;
export const MAX_COMMIT_MESSAGE = 20_000;
export const MAX_REL_PATH = 4096;

/** @param {unknown} v a file inside the folder: relative, every segment a name (no `.`, `..` or empty one, so no folder, no trailing `/`, no `./`), no NUL: a path naming the folder itself would discard or commit files nobody picked */
const relative = (v) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= MAX_REL_PATH &&
  !v.includes('\0') &&
  !v.startsWith('/') &&
  !/^[A-Za-z]:/.test(v) &&
  v.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..');

/** @param {(v: unknown, what: string) => string} pathOf schema.mjs's absolute-path check @param {(m: string) => Error} bad */
export const gitWriteParsers = (pathOf, bad) => {
  const rel = (/** @type {unknown} */ v) => {
    if (!relative(v)) throw bad('That is not a file inside the folder.');
    return /** @type {string} */ (v);
  };
  return {
    [GIT_COMMIT_METHOD]: (/** @type {any} */ p) => {
      if (typeof p.message !== 'string' || !p.message.trim() || p.message.length > MAX_COMMIT_MESSAGE || p.message.includes('\0'))
        throw bad('Write a commit message.');
      if (p.files !== null && !(Array.isArray(p.files) && p.files.length <= MAX_COMMIT_FILES)) throw bad('Pick the files to commit.');
      return {
        path: pathOf(p.path, 'a folder'),
        message: p.message,
        files:
          p.files === null
            ? null
            : p.files.map((/** @type {any} */ f) => ({
                path: rel(f?.path),
                ...(f?.oldPath == null ? {} : { oldPath: rel(f.oldPath) }),
                ...(f?.isCopy === true ? { isCopy: true } : {}),
                ...(f?.isDeleted === true ? { isDeleted: true } : {}),
              })),
      };
    },
    // a file, or null for every change in the folder
    [GIT_DISCARD_METHOD]: (/** @type {any} */ p) => ({ path: pathOf(p.path, 'a folder'), file: p.file == null ? null : rel(p.file) }),
  };
};
