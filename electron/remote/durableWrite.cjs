// Writes a whole file so that it appears at once and survives a crash, for Mobile Remote's sealed files: a 0600 temporary sibling, synced, renamed into place, then the folder synced; a crash leaves the old file or the new one, never an empty one. The same steps as electron/gateway/durableWrite.cjs (once MoMo's), kept here so this domain imports nothing from MoMo's (which would join it to the cycle of domains that import each other).
const crypto = require('node:crypto');
const path = require('node:path');
const { syncFolderAsync } = require('../platform/folderSync.cjs');

/** Syncs a folder, so a file created or renamed in it is on the disk (not on Windows: platform/folderSync.cjs). */
const syncDir = (/** @type {import('./sealedJson.cjs').FsPromises} */ fs, /** @type {string} */ dir) => syncFolderAsync(dir, { fs });

/**
 * @param {import('./sealedJson.cjs').FsPromises} fs
 * @param {string} file
 * @param {string} text
 */
async function writeDurable(fs, file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    const fh = await fs.open(tmp, 'wx', 0o600);
    try {
      await fh.write(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  try {
    await syncDir(fs, dir);
  } catch (error) {
    const uncertain = new Error(`The renamed file could not be synced: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
    Object.assign(uncertain, { renamed: true });
    throw uncertain;
  }
}

module.exports = { writeDurable, syncDir };
