// Resolve navigation folder identities in main without changing saved paths or chat working directories.
const fs = require('node:fs/promises');
const path = require('node:path');
const { isDirectory } = require('./directoryReads.cjs');

/** @param {string[]} paths */
async function canonicalPaths(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p)))
    throw new TypeError('Project folders must be absolute paths');
  const entries = await Promise.all(
    [...new Set(paths)].map(async (p) => {
      try {
        return [p, await fs.realpath(p)];
      } catch (error) {
        // Archived/deleted folders remain visible under their original identity.
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [p, p];
        throw error;
      }
    }),
  );
  return Object.fromEntries(entries);
}

// Keep one filesystem operation per path even after its answer times out. A stuck mount must neither hold healthy
// siblings nor accumulate more reads on every focus. Once it settles, the next poll can read that path afresh.
const availabilityReads = new Map();
function availabilityOf(p) {
  if (availabilityReads.has(p)) return availabilityReads.get(p);
  const work = (async () => {
    try {
      if (!(await isDirectory(p))) return false;
      await fs.access(p, fs.constants.R_OK | fs.constants.X_OK);
      return true;
    } catch (error) {
      return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code) ? false : null;
    }
  })();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), 2000);
  });
  const answer = Promise.race([work, timeout]);
  availabilityReads.set(p, answer);
  void work.then(() => {
    clearTimeout(timer);
    availabilityReads.delete(p);
  });
  return answer;
}

/** Local navigation availability only: null means an undecided/transient read, never permission to delete anything. */
async function folderAvailability(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !path.isAbsolute(p)))
    throw new TypeError('Project folders must be absolute paths');
  return Object.fromEntries(await Promise.all([...new Set(paths)].map(async (p) => [p, await availabilityOf(p)])));
}

module.exports = { canonicalPaths, folderAvailability };
