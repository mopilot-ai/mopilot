// Settings > About > Open-source notices: where the shipped THIRD_PARTY_NOTICES.md is.
// Packaged builds carry it in Contents/Resources (scripts/package.mjs extraResource); a dev checkout reads build/.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');

const FILE = 'THIRD_PARTY_NOTICES.md';

/**
 * The first existing candidate, or null.
 * @param {{ resourcesPath?: string, appPath?: string, exists?: (p: string) => boolean }} [o]
 */
function noticesPath({ resourcesPath, appPath, exists = fs.existsSync } = {}) {
  const candidates = [resourcesPath && path.join(resourcesPath, FILE), appPath && path.join(appPath, 'build', FILE)].filter(
    /** @returns {p is string} */ (p) => !!p,
  );
  return candidates.find((p) => exists(p)) ?? null;
}

/** Open the file in the user's default app. `openPath` is shell.openPath (resolves to '' on success, else the error text). */
async function openNotices({ openPath, ...where }) {
  const file = noticesPath(where);
  if (!file) return { ok: false, error: 'The notices file is missing from this build.' };
  const err = await openPath(file);
  return err ? { ok: false, error: err, path: file } : { ok: true, path: file };
}

module.exports = { FILE, noticesPath, openNotices };
