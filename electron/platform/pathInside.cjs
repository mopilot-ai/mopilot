// Whether a path lies inside a folder: as written (lexically), and by real paths, so a link inside that leads out of
// the folder counts as outside. One guard for the tools that read or show files only from a chat's folder.
const fs = require('node:fs');
const path = require('node:path');

/**
 * `p` is `dir` or under it, as written. A name that only starts with dots ("..notes") is inside. `paths` is the path
 * module to compare with (path.win32 for Windows paths and their casing).
 * @param {string} dir
 * @param {string} p
 */
function lexicalInside(dir, p, paths = path) {
  const rel = paths.relative(paths.resolve(dir), paths.resolve(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel));
}

/** The real path of `p`, or null when it isn't there. */
function realPath(/** @type {string} */ p) {
  try {
    return fs.realpathSync(p);
  } catch {
    // missing or unreadable: the caller reports it
    return null;
  }
}

/** The real path of `p`, or null when it isn't there (the promise form). */
async function realPathAsync(/** @type {string} */ p) {
  try {
    return await fs.promises.realpath(p);
  } catch {
    // missing or unreadable: the caller reports it
    return null;
  }
}

/**
 * The real path of `p` when it exists and its real path lies inside `dir`'s real path, else null.
 * @param {string} dir
 * @param {string} p
 * @returns {Promise<string | null>}
 */
async function realInside(dir, p) {
  const [folder, file] = await Promise.all([realPathAsync(dir), realPathAsync(p)]);
  return folder && file && lexicalInside(folder, file) ? file : null;
}

module.exports = { lexicalInside, realInside, realPath, realPathAsync };
