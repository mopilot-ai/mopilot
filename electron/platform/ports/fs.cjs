// The fs port (docs/architecture/modularization.md §3): the file system as the layers above L1 reach it. It is node:fs
// until a test installs a fake (tests/support/ports/fs.ts), and each use reads what is installed at that moment.
const nodeFs = require('node:fs');

/** @type {typeof import('node:fs')} */
let installed = nodeFs;

/**
 * Put `impl` behind the port (null puts node:fs back), and return the one it replaced so a test can restore it.
 * @param {typeof import('node:fs') | null} impl
 */
function installFs(impl) {
  const previous = installed;
  installed = impl ?? nodeFs;
  return previous;
}

/** The file system through the port: `fs.readFileSync(...)`, `fs.promises.readFile(...)`. */
const fs = /** @type {typeof import('node:fs')} */ (new Proxy({}, { get: (_target, key) => Reflect.get(installed, key) }));

module.exports = { fs, installFs };
