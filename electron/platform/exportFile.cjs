// Writing an exported transcript into the user's Downloads folder: a new file that never replaces an earlier one (the
// session-management tools' export_transcript, app/sessionHost.cjs).
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Write `text` to `<dir>/<base>.md`, or `<base>-1.md`, `<base>-2.md`… when that name is taken; private to the user.
 * @param {string} dir
 * @param {string} base
 * @param {string} text
 * @returns {Promise<{ file: string, bytes: number }>}
 */
async function writeNewExport(dir, base, text, n = 0) {
  const file = path.join(dir, `${base}${n ? `-${n}` : ''}.md`);
  try {
    await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
    return { file, bytes: Buffer.byteLength(text) };
  } catch (error) {
    if (/** @type {any} */ (error).code !== 'EEXIST') throw error;
  }
  return writeNewExport(dir, base, text, n + 1);
}

module.exports = { writeNewExport };
