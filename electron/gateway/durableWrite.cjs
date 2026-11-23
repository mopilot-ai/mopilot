// Writes a whole file so that it appears at once and survives a crash (#2139), for the gateway's sealed files and MoMo's trust files (the audit key, the remembered approvals): the text goes to a 0600 temporary sibling, is synced, renamed into place, and the folder is synced so the new name is on the disk too; a crash leaves the old file or the new one, never an empty one.
const crypto = require('node:crypto');
const path = require('node:path');
const { syncFolderAsync } = require('../platform/folderSync.cjs');

/** Syncs a folder, so a file created or renamed in it is on the disk (not on Windows: platform/folderSync.cjs). */
const syncDir = (/** @type {typeof import('../platform/ports/fs.cjs').fs.promises} */ fs, /** @type {string} */ dir) =>
  syncFolderAsync(dir, { fs });

/**
 * @param {typeof import('../platform/ports/fs.cjs').fs.promises} fs
 * @param {string} file
 * @param {string | Buffer} text
 */
async function writeDurable(fs, file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    const fh = await fs.open(tmp, 'wx', 0o600);
    try {
      await fh.write(/** @type {any} */ (text)); // a string, or the bytes of a file main built
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  await syncDir(fs, dir);
}

module.exports = { writeDurable, syncDir };
