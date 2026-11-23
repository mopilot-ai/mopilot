// Things read from the user's Chrome setup, read only: whether Claude in Chrome was used before (for the
// one-time migration note) and which version of the Playwright Extension is installed (for the connection
// test). Nothing here writes to Chrome's or Claude's files.
const { noteIgnored } = require('../../ignored.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { CHROMIUM_BROWSERS, browserUserData, chromiumUserDataDirs } = require('./chromiumBrowsers.cjs');

const PLAYWRIGHT_EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';

/**
 * Google Chrome's user data folder on this platform.
 * @param {{ home?: string, platform?: string, env?: Record<string, string|undefined> }} [o]
 * @returns {string}
 */
function chromeUserData(o = {}) {
  return /** @type {string} */ (browserUserData(CHROMIUM_BROWSERS[0], o));
}

/**
 * Whether Claude in Chrome was used before: Claude Code's own config says it was enabled by default, or
 * its native messaging host is registered with a Chromium-family browser (chromiumBrowsers.cjs).
 * @param {{ home?: string, platform?: NodeJS.Platform, env?: Record<string, string|undefined>, fs?: typeof fs }} [o]
 */
function usedClaudeInChrome(o = {}) {
  const f = o.fs ?? fs;
  const home = o.home ?? os.homedir();
  try {
    const cfg = JSON.parse(f.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    if (cfg && cfg.claudeInChromeDefaultEnabled === true) return true;
  } catch (error) {
    // no readable ~/.claude.json: fall through to the next check
    noteIgnored('read ~/.claude.json for the Claude in Chrome migration note', error, ['ENOENT']);
  }
  return chromiumUserDataDirs({ home, platform: o.platform, env: o.env }).some(({ dir }) => {
    try {
      return f.readdirSync(path.join(dir, 'NativeMessagingHosts')).some((n) => /^com\.anthropic\.claude.*\.json$/i.test(n));
    } catch {
      return false;
    }
  });
}

/** -1, 0 or 1; compares dotted numbers ("0.0.83", an installed "0.0.83_0" counts as 0.0.83). */
function compareVersions(a, b) {
  const parts = (v) =>
    String(v)
      .split('_')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The profile Chrome opens when none is named (Local State's profile.last_used), or null when it doesn't say. */
function lastUsedProfile(f, root) {
  try {
    const last = JSON.parse(f.readFileSync(path.join(root, 'Local State'), 'utf8'))?.profile?.last_used;
    return typeof last === 'string' && last ? last : null;
  } catch {
    return null;
  }
}

/**
 * The newest installed version of the Playwright Extension in the chosen Chrome profile, else in the profile
 * Chrome opens (the one Your Chrome connects to), else in any profile when Chrome doesn't say which; read
 * from the profile's Extensions folder; null when it isn't installed there.
 * @param {{ profileDir?: string | null, userData?: string, fs?: typeof fs }} [o]
 */
function installedExtensionVersion(o = {}) {
  const f = o.fs ?? fs;
  const root = o.userData ?? chromeUserData();
  const chosen = o.profileDir || lastUsedProfile(f, root);
  let profiles;
  try {
    profiles = chosen ? [chosen] : f.readdirSync(root).filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
  } catch {
    return null;
  }
  /** @type {string | null} */
  let best = null;
  for (const p of profiles) {
    try {
      for (const v of f.readdirSync(path.join(root, p, 'Extensions', PLAYWRIGHT_EXTENSION_ID))) {
        const manifest = JSON.parse(f.readFileSync(path.join(root, p, 'Extensions', PLAYWRIGHT_EXTENSION_ID, v, 'manifest.json'), 'utf8'));
        if (manifest.version && (!best || compareVersions(manifest.version, best) > 0)) best = String(manifest.version);
      }
    } catch (error) {
      // this profile has no Playwright extension installed (ENOENT), or an unreadable manifest
      noteIgnored('read the Playwright Extension version in a Chrome profile', error, ['ENOENT']);
    }
  }
  return best;
}

/**
 * What the connection test says about the extension's version against the one this release is pinned to.
 * @returns {{ installed: string | null, pinned: string, status: 'ok' | 'older' | 'unknown', message: string | null }}
 */
function extensionVersionCheck(installed, pinned) {
  if (!installed) return { installed: null, pinned, status: 'unknown', message: null };
  if (compareVersions(installed, pinned) < 0)
    return {
      installed,
      pinned,
      status: 'older',
      message: `The Playwright Extension is version ${installed}; this version of MoPilot is tested with ${pinned}. Update it in Chrome.`,
    };
  return { installed, pinned, status: 'ok', message: null };
}

module.exports = {
  usedClaudeInChrome,
  installedExtensionVersion,
  extensionVersionCheck,
  compareVersions,
  chromeUserData,
  lastUsedProfile,
  PLAYWRIGHT_EXTENSION_ID,
};
