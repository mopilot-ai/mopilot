// Whether two working directories can include the same files in their tree snapshots.
const path = require('node:path');
const { lexicalInside } = require('../platform/pathInside.cjs');

/** Compare directory boundaries, including parent segments and native Windows casing. */
function overlappingDirectories(a, b, paths = path) {
  return lexicalInside(a, b, paths) || lexicalInside(b, a, paths);
}

module.exports = { overlappingDirectories };
