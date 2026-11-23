// Where the developer tools (browser_record, browser_har, browser_perf_trace) save in a chat's upload folder: a private subfolder and a free file name, never overwriting.
const path = require('node:path');
const { fs } = require('../../../platform/ports/fs.cjs');
const { mkdirPrivate } = require('../../../platform/privateFiles.cjs');

/** A file name the agent asked for, reduced to letters, digits, ".", "-" and "_" (empty when nothing is left). */
const cleanName = (/** @type {unknown} */ name, /** @type {string} */ ext) =>
  String(name ?? '')
    .replace(new RegExp(`\\.${ext}$`, 'i'), '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|-+$/g, '')
    .slice(0, 80);

/**
 * A new file `<root>/<sub>/<name>.<ext>` (or `<name>-2.<ext>`, ... when taken), created empty with mode 0600; returns its path.
 * `name` defaults to `<what>-<time>`.
 */
function freeFile(
  /** @type {string} */ root,
  /** @type {string} */ sub,
  /** @type {unknown} */ name,
  /** @type {string} */ what,
  /** @type {string} */ ext,
) {
  const dir = path.join(root, sub);
  mkdirPrivate(dir);
  const base = cleanName(name, ext) || `${what}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  /** @returns {string} the first free name from `-n` on */
  const open = (/** @type {number} */ n) => {
    const file = path.join(dir, `${base}${n > 1 ? `-${n}` : ''}.${ext}`);
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      return file;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      return open(n + 1);
    }
  };
  return open(1);
}

module.exports = { freeFile, cleanName };
