// Whether an extension is installed and turned on in the Chrome profile a page would open in, read from the profile's preferences.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { chromeUserData, lastUsedProfile } = require('./chromeMigration.cjs');

/** Whether an extension's settings entry says it is turned off (disable_reasons: a bitmask in older Chrome, a list in newer). */
const turnedOff = (/** @type {any} */ s) =>
  (Array.isArray(s.disable_reasons) ? s.disable_reasons.length > 0 : Number(s.disable_reasons) > 0) || s.state === 0;

/**
 * The extension `id` in the Chrome profile a page opens in (#1319 G29): 'on', 'off' (installed but turned off) or
 * 'missing', or null when the profile's preferences can't be read (then nothing is decided from them). The profile is
 * the one named, else the one Chrome opens (Local State), else Default; the folder is MOPILOT_CHROME_RELAY_USER_DATA_DIR
 * when set (as openInChrome uses it), else Chrome's own.
 * @param {string} id
 * @param {{ profileDir?: string | null, userData?: string, env?: Record<string, string | undefined>, fs?: typeof fs }} [o]
 * @returns {'on' | 'off' | 'missing' | null}
 */
function extensionInProfile(id, o = {}) {
  const f = o.fs ?? fs;
  const env = o.env ?? process.env;
  const root = o.userData ?? (env.MOPILOT_CHROME_RELAY_USER_DATA_DIR || chromeUserData());
  const profile = o.profileDir || lastUsedProfile(f, root) || 'Default';
  let read = false;
  // Chrome keeps an extension's settings in Secure Preferences, or in Preferences when the profile has none
  for (const name of ['Secure Preferences', 'Preferences']) {
    let prefs;
    try {
      prefs = JSON.parse(f.readFileSync(path.join(root, profile, name), 'utf8'));
    } catch {
      continue;
    }
    read = true;
    const s = prefs?.extensions?.settings?.[id];
    if (s && typeof s === 'object') return turnedOff(s) ? 'off' : 'on';
  }
  return read ? 'missing' : null;
}

module.exports = { extensionInProfile };
