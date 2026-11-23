// A bounded walk of one design system's or design's folder: the files in it as folder-relative POSIX paths, without
// following links to folders, skipping dot folders and node_modules, and stopping at the file and depth limits.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { LIMITS } = require('../../shared/designSystem.mjs');

const SKIP = new Set(['node_modules', '.git']);
/** The error codes that mean "nothing there" (or not a file), which a reader answers as absent; any other is a failure. */
const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);
const isAbsent = (/** @type {unknown} */ e) => ABSENT.has(Object(e).code);
/** null for an error that means nothing (or a folder) is there, as `promise.catch(absentAsNull)`; any other is thrown. */
function absentAsNull(/** @type {unknown} */ e) {
  if (isAbsent(e)) return null;
  throw e;
}
/** Folder entries in name order (names in one folder never repeat). */
const byName = (/** @type {{ name: string }} */ a, /** @type {{ name: string }} */ b) => (a.name < b.name ? -1 : 1);

/**
 * @param {string} root an existing folder
 * @param {{ files?: number, depth?: number, fsp?: typeof fs.promises }} [o]
 * @returns {Promise<{ files: string[], truncated: boolean, unreadable: string[] }>} files sorted by path; folders that
 *   exist but could not be listed, by their path in `root` ('' for `root` itself)
 */
async function walk(root, o = {}) {
  const max = o.files ?? LIMITS.files;
  const maxDepth = o.depth ?? LIMITS.depth;
  const fsp = o.fsp ?? fs.promises;
  /** @type {string[]} */
  const files = [];
  let truncated = false;
  /** @type {string[]} */
  const unreadable = [];
  /** @param {string} rel @param {number} depth */
  const visit = async (rel, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch (e) {
      // a folder gone since its parent was listed holds nothing; one that can't be listed is a problem the reader names
      if (!isAbsent(e)) unreadable.push(rel);
      return;
    }
    entries.sort(byName);
    for (const e of entries) {
      if (files.length >= max) {
        truncated = true;
        return;
      }
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        if (depth + 1 > maxDepth) {
          truncated = true;
          continue;
        }
        await visit(child, depth + 1);
      } else if (e.isFile()) files.push(child);
    }
  };
  await visit('', 0);
  return { files, truncated, unreadable };
}

module.exports = { walk, isAbsent, absentAsNull, byName };
