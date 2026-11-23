// A projectless chat's own folder (<projectless folder>/<date>/<slug>, -2, -3… for the same name that day), made in main for the app's windows (fs:mkdirProjectless) and for chats started from Chrome's side panel alike.
const fs = require('node:fs');
const path = require('node:path');
const { testRunFolder } = require('./testChats.cjs');
const { userError } = require('../../shared/userError.mjs');

/** How many projectless chats one day may give the same name (slug, slug-2 … slug-1000). */
const MAX_SAME_NAME = 1000;
const SEGMENT = /^[\w.-]+$/;

/** A folder name from a chat's opening words, as the renderer makes one (src/store/projects.ts projectlessCwd). */
function slugOf(seed) {
  return (
    String(seed ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'chat'
  );
}

/**
 * Makes the folder; a test instance on the user's own home makes it in its run's scratch folder instead
 * (platform/testChats.cjs).
 * @param {unknown} asked the projectless folder @param {unknown} date @param {unknown} slug
 * @param {string | null} [testRun]
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function makeProjectlessFolder(asked, date, slug, testRun = testRunFolder()) {
  const root = testRun && typeof asked === 'string' && path.isAbsolute(asked) ? testRun : asked;
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    typeof date !== 'string' ||
    typeof slug !== 'string' ||
    !SEGMENT.test(date) ||
    !SEGMENT.test(slug) ||
    date.startsWith('.') ||
    slug.startsWith('.')
  )
    return { ok: false, error: 'invalid folder name' };
  try {
    fs.mkdirSync(path.join(root, date), { recursive: true });
    // made, not found: an existing folder is another chat's, and the next name is tried
    for (let n = 1; n <= MAX_SAME_NAME; n++) {
      const dir = path.join(root, date, n === 1 ? slug : `${slug}-${n}`);
      try {
        fs.mkdirSync(dir);
        return { ok: true, path: dir };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    return { ok: false, error: `${MAX_SAME_NAME} chats that day already have this name` };
  } catch (err) {
    return { ok: false, error: userError(err) };
  }
}

/** The projectless folder the app's settings name, else ~/Documents/MoPilot (src/store/types.ts projectlessFolderOf). */
const projectlessRoot = (prefs, home) =>
  prefs?.projectlessFolder ? String(prefs.projectlessFolder) : path.join(home, 'Documents', 'MoPilot');

module.exports = { makeProjectlessFolder, projectlessRoot, slugOf, MAX_SAME_NAME };
