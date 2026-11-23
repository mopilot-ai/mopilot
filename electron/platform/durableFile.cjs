// Publish one state file atomically and wait for file and directory durability before acknowledging it.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { syncFolder } = require('./folderSync.cjs');
const { isPrivatePath, ownerOnly, PRIVATE_FILE } = require('./privateFiles.cjs');

/** @param {string} file @param {string | Buffer} data @param {any} fs @param {number} [mode] @param {() => string} [nonce] */
function writeDurable(file, data, fs, mode, nonce = randomUUID) {
  const owned = isPrivatePath(file);
  const kept = fs.statSync(file, { throwIfNoEntry: false })?.mode ?? mode ?? (owned ? PRIVATE_FILE : undefined);
  const permissions = owned && kept !== undefined ? ownerOnly(kept) : kept;
  return publish(file, data, fs, permissions, nonce);
}

/** Strictly private state: never inherit broader permissions from a pre-existing file. @param {string} file @param {string | Buffer} data @param {any} fs @param {() => string} [nonce] */
function writePrivateDurable(file, data, fs, nonce = randomUUID) {
  return publish(file, data, fs, PRIVATE_FILE, nonce);
}

/** @param {string} file @param {string | Buffer} data @param {any} fs @param {number | undefined} permissions @param {() => string} nonce */
function publish(file, data, fs, permissions, nonce) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.mopilot-${nonce()}.tmp`);
  let created = false;
  let renamed = false;
  try {
    const fd = fs.openSync(tmp, 'wx', permissions === undefined ? 0o666 : permissions & 0o777);
    created = true;
    try {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('The state file could not be written completely');
        offset += written;
      }
      if (permissions !== undefined) fs.fchmodSync(fd, permissions & 0o777);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    renamed = true;
    syncFolder(dir, { fs });
  } finally {
    if (created && !renamed) fs.rmSync(tmp, { force: true });
  }
}
module.exports = { writeDurable, writePrivateDurable };
