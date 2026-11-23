// Nonblocking directory metadata shared by file search and the renderer's directory tree.
const fs = require('node:fs');

/** Missing paths are not folders; other filesystem failures remain visible to the caller. */
async function isDirectory(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

module.exports = { isDirectory };
