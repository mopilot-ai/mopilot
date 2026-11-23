// Atomic user-directed text replacement follows symlinks and preserves prior contents on failure.
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('./fsutil.cjs');

/** Write through file and directory aliases without publishing partial contents. */
function writeTextAtomic(file, text) {
  const directories = new Set();
  const target = resolveWritePath(file, new Set(), directories);
  // Check actual write access without truncating or creating the existing target (including Windows ACLs).
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (fd !== undefined) fs.closeSync(fd);
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
  writeAtomic(target, text);
}

/** Follow unresolved symlinks without replacing them when their target is missing. */
function resolveWritePath(target, seen, directories) {
  if (seen.has(target)) throw new Error('Symbolic link cycle');
  seen.add(target);
  try {
    try {
      return fs.realpathSync.native(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      let link;
      try {
        link = fs.readlinkSync(target);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          const parent = path.dirname(target);
          if (parent === target) return target;
          const directory = resolveWritePath(parent, seen, directories);
          // Traversing '..' still requires its preceding directory to exist; prepare it after cycle checks.
          if (path.basename(target) === '..') directories.add(directory);
          const resolved = path.join(directory, path.basename(target));
          return resolved === target ? resolved : resolveWritePath(resolved, seen, directories);
        }
        throw error;
      }
      // The filesystem follows directory links before interpreting '..' inside a link target.
      return resolveWritePath(path.isAbsolute(link) ? link : `${path.dirname(target)}${path.sep}${link}`, seen, directories);
    }
  } finally {
    seen.delete(target);
  }
}

module.exports = { writeTextAtomic };
