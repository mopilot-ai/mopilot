// Offers MoPilot's Chrome extension to Google Chrome through its per-user External Extensions preference (#1632): the one install path Chrome allows without the user visiting the Web Store.
//
// - macOS reads ~/Library/Application Support/Google/Chrome/External Extensions/<id>.json at its next start. With
//   {"external_update_url": <the Web Store's update URL>} Chrome shows "New extension added" and the user enables it
//   with one click; nothing is installed silently. Windows would be a registry key and is not done (the native host is
//   macOS only too); other Chromium browsers are left out because only Google Chrome is paired with and hosts the
//   native messaging host (chromeNativeHost.cjs hostFolders).
// - The file is written once per install state: when Chrome has a user data folder, neither the store's nor the dev
//   key's extension is in the profile, and the offer wasn't made before to this Chrome folder (a small record in
//   MoPilot's data). A user who removes the extension is remembered by Chrome itself (external_uninstalls), and a
//   file that holds anything else, or is a link, is never replaced.
// - Turned off (the switch), the file goes only when it is ours and no profile in the folder
//   has the extension (the file covers them all). While one has it the file stays: Chrome removes an extension its
//   preference no longer lists. Turning it on again after a take-back offers again. MoPilot
//   on macOS has no uninstall step to run, so dragging the app away leaves the file, which only offers the listing.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');
const { readJson, writeAtomic } = require('../../platform/fsutil.cjs');
const { chromeUserData } = require('./chromeMigration.cjs');

/** The Web Store's update URL Chrome fetches a listed extension from. */
const EXTERNAL_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

const BODY = `${JSON.stringify({ external_update_url: EXTERNAL_UPDATE_URL }, null, 2)}\n`;

/**
 * Where the preference file for extension `id` goes, and the Chrome folder it needs: the scratch folder a run was
 * pointed at (MOPILOT_CHROME_RELAY_USER_DATA_DIR) else Google Chrome's own. Null off macOS.
 * @param {{ id: string, env?: Record<string, string | undefined>, home?: string, platform?: string }} o
 * @returns {{ root: string, file: string } | null}
 */
function externalFile({ id, env = process.env, home, platform = process.platform }) {
  if (platform !== 'darwin') return null;
  const root = env.MOPILOT_CHROME_RELAY_USER_DATA_DIR
    ? path.resolve(env.MOPILOT_CHROME_RELAY_USER_DATA_DIR)
    : chromeUserData({ home, platform });
  return { root, file: path.join(root, 'External Extensions', `${id}.json`) };
}

/** The profile folders of a Chrome user data folder that can hold the extension: Default and Profile N. @param {string} root @param {typeof fs} [f] */
function profileFolders(root, f = fs) {
  try {
    return f.readdirSync(root).filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
  } catch {
    return [];
  }
}

/** Whether anything, even a dangling link, is at `file`. */
const taken = (f, file) => {
  try {
    f.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Whether the file at `file` is the one this module writes. */
const isOurs = (f, file) => {
  try {
    return f.readFileSync(file, 'utf8') === BODY;
  } catch {
    return false;
  }
};

/**
 * Brings the preference file in line with the switch and the profile; idempotent.
 * @param {{ id: string, enabled: boolean, state: 'on' | 'off' | 'missing' | null, stateFile: string,
 *           env?: Record<string, string | undefined>, home?: string, platform?: string, fs?: typeof fs }} o
 *   state: the extension across the Chrome folder's profiles (app/chromeRelay.cjs offerChromeExtension); stateFile: where the offer is recorded
 * @returns {'unsupported' | 'no-chrome' | 'installed' | 'offered-before' | 'present' | 'written' | 'removed' | 'off' | 'failed'}
 */
function syncExternalInstall({ id, enabled, state, stateFile, env, home, platform, fs: f = fs }) {
  const where = externalFile({ id, env, home, platform });
  if (!where) return 'unsupported';
  const ours = isOurs(f, where.file);
  try {
    if (!enabled) {
      if (!ours || state !== 'missing') return 'off';
      f.rmSync(where.file, { force: true });
      // a later switch back on offers again
      f.rmSync(stateFile, { force: true });
      return 'removed';
    }
    if (!f.existsSync(where.root)) return 'no-chrome';
    if (state === 'on' || state === 'off') return 'installed';
    if (taken(f, where.file)) return 'present';
    const before = readJson(stateFile);
    if (before?.offered === id && before.root === where.root) return 'offered-before';
    writeAtomic(where.file, BODY, f, 0o644);
    writeAtomic(stateFile, `${JSON.stringify({ offered: id, root: where.root })}\n`, f, 0o600);
    return 'written';
  } catch (error) {
    noteIgnored("write MoPilot's Chrome extension preference", error);
    return 'failed';
  }
}

module.exports = { EXTERNAL_UPDATE_URL, externalFile, profileFolders, syncExternalInstall };
