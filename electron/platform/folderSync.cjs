// Syncs a folder's entries to the disk after a file in it was created, renamed or removed, on the systems that can: macOS and Linux fsync the folder, and Windows, which refuses to flush a folder (EPERM) and journals the rename itself, skips it. @host-portable
const nodeFs = require('node:fs');
const { withAsyncCleanup, withCleanup } = require('./cleanup.cjs');

/**
 * Whether a folder can be synced here. Windows opens a folder only for reading its attributes, and FlushFileBuffers on
 * that handle is refused (EPERM), so a durable write that synced its folder failed there after the rename had landed;
 * NTFS logs the rename in its own journal, so there is nothing to sync.
 * @param {NodeJS.Platform} [platform]
 */
const canSyncFolder = (platform = process.platform) => platform !== 'win32';

/**
 * Syncs `dir`, so a file created, renamed or removed in it is on the disk; nothing on Windows (canSyncFolder).
 * @param {string} dir
 * @param {{ fs?: Pick<typeof nodeFs, 'openSync' | 'fsyncSync' | 'closeSync'>, platform?: NodeJS.Platform }} [o]
 */
function syncFolder(dir, { fs = nodeFs, platform = process.platform } = {}) {
  if (!canSyncFolder(platform)) return;
  const fd = fs.openSync(dir, 'r');
  // a close that fails after a failed sync must not hide the sync's error
  withCleanup(
    () => fs.fsyncSync(fd),
    () => fs.closeSync(fd),
  );
}

/**
 * syncFolder with a promise-based fs (fs.promises or a port of it).
 * @param {string} dir
 * @param {{ fs?: { open: (path: string, flags: string) => Promise<{ sync(): Promise<void>, close(): Promise<void> }> }, platform?: NodeJS.Platform }} [o]
 */
async function syncFolderAsync(dir, { fs = nodeFs.promises, platform = process.platform } = {}) {
  if (!canSyncFolder(platform)) return;
  const fh = await fs.open(dir, 'r');
  await withAsyncCleanup(
    () => fh.sync(),
    () => fh.close(),
  );
}

module.exports = { canSyncFolder, syncFolder, syncFolderAsync };
