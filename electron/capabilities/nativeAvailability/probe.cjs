// Read-only vendor browser/runtime/computer probes and native-plugin surface restrictions.
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { CHROMIUM_BROWSERS, chromiumUserDataDirs, vendorChromeUserDataDirs } = require('../browser/chromiumBrowsers.cjs');
const { pluginListsChrome } = require('../browser/chromeControl.cjs');
const { plistVersion, versionsNewestFirst } = require('../../../shared/skyComputerUse.mjs');

const SKY_BUNDLE_ID = 'com.openai.sky.CUAService';
const OPENAI_CHROME_HOST = 'com.openai.codexextension';
const CLAUDE_CHROME_HOSTS = ['com.anthropic.claude_code_browser_extension', 'com.anthropic.claude_browser_extension'];
const CUA_PLUGIN_DIR = 'unified-computer-use';
const SKY_APP = 'Codex Computer Use.app';
const exists = (f, p) => {
  try {
    return !!p && f.existsSync(p);
  } catch {
    return false;
  }
};
const readJson = (f, p) => {
  try {
    return JSON.parse(f.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
const listDir = (f, p) => {
  try {
    return f.readdirSync(p);
  } catch {
    return [];
  }
};

/** The plugin's cua_repl command in a .mcp.json, or null. */
function mcpCommand(json) {
  const c = json?.mcpServers?.cua_repl?.command;
  return typeof c === 'string' ? c : null;
}

/** The Sky app path the plugin's .mcp.json names, or null. */
function mcpSkyPath(json) {
  const p = json?.mcpServers?.cua_repl?.env?.SKY_CUA_SERVICE_PATH;
  return typeof p === 'string' ? p : null;
}

/** The node_modules folders the plugin's .mcp.json gives its runtime (where @oai/sky ships Sky). */
function mcpModuleDirs(json) {
  const p = json?.mcpServers?.cua_repl?.env?.NODE_REPL_NODE_MODULE_DIRS;
  return typeof p === 'string' ? p.split(':').filter(Boolean) : [];
}

/** A comma-separated list in the plugin's cua_repl env, or null when the plugin doesn't set it (no restriction). */
function mcpList(json, key) {
  const v = json?.mcpServers?.cua_repl?.env?.[key];
  return typeof v === 'string'
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : null;
}

/**
 * The Codex plugin runtime this Codex home really loads: the plugin materialized in its plugins cache (the
 * newest version, compared as numbers) whose cua_repl command exists, and what that copy enables
 * (CUA_REPL_ENABLED_SURFACES, BROWSER_USE_AVAILABLE_BACKENDS; a list the plugin doesn't set restricts
 * nothing). A ChatGPT.app on this Mac is only named (`app`): its bundle is not what Codex threads load.
 */
function probeCodexRuntime(f, { codexHome, appDirs }) {
  const cache = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', CUA_PLUGIN_DIR);
  for (const v of versionsNewestFirst(listDir(f, cache))) {
    const mcp = readJson(f, path.join(cache, v, '.mcp.json'));
    if (exists(f, path.join(cache, v, '.codex-plugin')) && exists(f, mcpCommand(mcp)))
      return {
        present: true,
        source: 'plugins-cache',
        version: v,
        app: null,
        surfaces: mcpList(mcp, 'CUA_REPL_ENABLED_SURFACES'),
        backends: mcpList(mcp, 'BROWSER_USE_AVAILABLE_BACKENDS'),
        mcp,
        modules: mcpModuleDirs(mcp),
      };
  }
  const app = appDirs.map((d) => path.join(d, 'ChatGPT.app')).find((p) => exists(f, p)) ?? null;
  return { present: false, source: null, version: null, app, surfaces: null, backends: null, mcp: null, modules: [] };
}

/** Whether the installed plugin enables a surface ('computer', 'browser') and, for Chrome, its Chrome backend. */
const pluginEnables = (runtime, surface) =>
  (!runtime.surfaces || runtime.surfaces.includes(surface)) &&
  (surface !== 'browser' || !runtime.backends || pluginListsChrome(runtime.backends));

/** A Sky app's Info.plist when it carries Sky's bundle id, else null. */
function skyPlist(f, app) {
  try {
    const plist = f.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
    return plist.includes(SKY_BUNDLE_ID) ? plist : null;
  } catch {
    return null;
  }
}

/**
 * The Codex Computer Use app (Sky): where the plugin says it is, or its canonical place in the Codex home
 * (`canonical`, where it is installed), with Sky's bundle id; its version (CFBundleShortVersionString); and
 * the copy the Codex runtime ships (`source`, `bundled` its version), the one installed or updated from.
 * Versions are null when unknown.
 */
function probeSky(f, { codexHome, mcp, modules }) {
  /** @type {string | null} */
  let bundled = null;
  /** @type {string | null} */
  let source = null;
  for (const app of modules.flatMap((dir) => [
    path.join(dir, '@oai', 'sky', SKY_APP),
    path.join(dir, '@oai', 'sky', 'bin', 'mac', 'normal', SKY_APP),
  ])) {
    const plist = skyPlist(f, app);
    if (plist) {
      bundled = plistVersion(plist);
      source = app;
      break;
    }
  }
  const canonical = path.join(codexHome, 'computer-use', SKY_APP);
  for (const app of [mcpSkyPath(mcp), canonical]) {
    const plist = app ? skyPlist(f, app) : null;
    if (plist) return { present: true, path: app, version: plistVersion(plist), bundled, source, canonical };
  }
  return { present: false, path: null, version: null, bundled, source, canonical };
}

/**
 * An extension in one Chrome profile, read as Chrome records it (as the vendor's check-extension-installed.js
 * does): installed (its Extensions folder), and enabled (its entry in Secure Preferences or Preferences,
 * without a disable reason and not in state 0).
 */
function extensionInProfile(f, profileDir, id) {
  if (!exists(f, path.join(profileDir, 'Extensions', id))) return { installed: false, enabled: false };
  for (const file of ['Secure Preferences', 'Preferences']) {
    const entry = readJson(f, path.join(profileDir, file))?.extensions?.settings?.[id];
    if (!entry || typeof entry !== 'object') continue;
    const reasons = entry.disable_reasons;
    const disabled = entry.state === 0 || (Array.isArray(reasons) ? reasons.length > 0 : typeof reasons === 'number' && reasons !== 0);
    return { installed: true, enabled: !disabled };
  }
  // in the folder but not registered with the profile: Chrome hasn't loaded it
  return { installed: true, enabled: false };
}

/**
 * A Chrome native-messaging host: its manifest is registered (and names a program that exists), and one of
 * the extensions it allows is installed (`extension`) and turned on (`enabled`, `ready`) in a Chrome profile.
 */
function probeChromeHost(f, { userData, names }) {
  const found = hostExtensions(f, { userData, names });
  if (!found) return { host: false, extension: false, enabled: false, ready: false };
  const enabled = found.some((e) => e.enabled);
  return { host: true, extension: found.some((e) => e.installed), enabled, ready: enabled };
}

/**
 * The first registered host's allowed extensions in each profile of one browser (`profile`: its folder name), or
 * null when no host of `names` is registered there with a program that exists.
 */
function hostExtensions(f, { userData, names }) {
  for (const name of names) {
    const manifest = readJson(f, path.join(userData, 'NativeMessagingHosts', `${name}.json`));
    if (!manifest || !exists(f, manifest.path)) continue;
    const ids = (Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [])
      .map((o) => /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(String(o))?.[1])
      .filter(Boolean);
    const profiles = listDir(f, userData).filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
    return ids.flatMap((id) => profiles.map((p) => ({ profile: p, ...extensionInProfile(f, path.join(userData, p), id) })));
  }
  return null;
}

/** The native-messaging hosts of each vendor controller of the user's Chrome. */
const VENDOR_CHROME_HOSTS = { 'claude-in-chrome': CLAUDE_CHROME_HOSTS, 'codex-browser-plugin': [OPENAI_CHROME_HOST] };

/**
 * The browser and profile a vendor controller of the user's Chrome is paired with: the first Chromium-family browser
 * (Google Chrome first) with its host registered and its extension on in a profile, or null (not on this Mac).
 * @param {'claude-in-chrome' | 'codex-browser-plugin'} controller
 * @param {{ fs?: typeof fs, home?: string, platform?: string, env?: Record<string, string|undefined>, userData?: string }} [o]
 *   userData: look in this Google Chrome folder only (a run's scratch profile, which openSite.cjs opens Chrome on)
 * @returns {{ browser: string, name: string, profile: string } | null}
 */
function vendorChromeProfile(controller, o = {}) {
  const f = o.fs ?? fs;
  // else the browsers' own folders only: openSite.cjs opens the result as a new instance of that browser with a
  // profile, which for a scratch folder (MOPILOT_CHROME_RELAY_USER_DATA_DIR) would start the user's own Chrome
  const dirs = o.userData
    ? [{ id: CHROMIUM_BROWSERS[0].id, name: CHROMIUM_BROWSERS[0].name, dir: o.userData }]
    : chromiumUserDataDirs({ home: o.home ?? os.homedir(), platform: o.platform ?? process.platform, env: o.env });
  for (const b of dirs) {
    const on = hostExtensions(f, { userData: b.dir, names: VENDOR_CHROME_HOSTS[controller] })?.find((e) => e.enabled);
    if (on) return { browser: b.id, name: b.name, profile: on.profile };
  }
  return null;
}

/**
 * A native-messaging host across every Chromium-family browser (chromiumBrowsers.cjs): each browser reads its
 * own NativeMessagingHosts folder and profiles, so a browser counts only with the host registered and the
 * extension on in it; the surface is ready when any browser has both.
 * browsers: their user data folders.
 */
function probeChromeHosts(f, { browsers, names }) {
  const each = browsers.map((userData) => probeChromeHost(f, { userData, names }));
  const any = (/** @type {'host' | 'extension' | 'enabled' | 'ready'} */ k) => each.some((b) => b[k]);
  return { host: any('host'), extension: any('extension'), enabled: any('enabled'), ready: any('ready') };
}

/**
 * What this Mac has, read from the file system. Only macOS has the vendor runtimes; elsewhere every native
 * surface reads as missing, so sessions keep MoPilot's own tools.
 * @param {{ fs?: typeof fs, home?: string, codexHome?: string, platform?: string, appDirs?: string[],
 *           env?: Record<string, string|undefined> }} [o]
 *   codexHome: the CODEX_HOME MoPilot's app-server runs with (default ~/.codex)
 */
function probeNativeAvailability(o = {}) {
  const f = o.fs ?? fs;
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  const none = { host: false, extension: false, enabled: false, ready: false };
  if (platform !== 'darwin') {
    return {
      platform,
      codex: {
        runtime: { present: false, source: null, version: null, app: null, surfaces: null, backends: null },
        sky: { present: false, path: null, version: null, bundled: null, source: null, canonical: null },
        chrome: none,
      },
      claude: { chrome: none },
    };
  }
  const appDirs = o.appDirs ?? ['/Applications', path.join(home, 'Applications')];
  const codexHome = o.codexHome ?? path.join(home, '.codex');
  // with the scratch profile MoPilot was pointed at, where the Chrome comparison's native arm runs the extensions
  const browsers = vendorChromeUserDataDirs({ home, platform, env: o.env }).map((b) => b.dir);
  const { mcp, modules, ...runtime } = probeCodexRuntime(f, { codexHome, appDirs });
  return {
    platform,
    codex: {
      runtime,
      sky: probeSky(f, { codexHome, mcp, modules }),
      chrome: probeChromeHosts(f, { browsers, names: [OPENAI_CHROME_HOST] }),
    },
    claude: { chrome: probeChromeHosts(f, { browsers, names: CLAUDE_CHROME_HOSTS }) },
  };
}

module.exports = { probeNativeAvailability, pluginEnables, SKY_BUNDLE_ID, OPENAI_CHROME_HOST, CLAUDE_CHROME_HOSTS, vendorChromeProfile };
