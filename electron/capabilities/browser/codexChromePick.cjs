// Which Codex Browser plugin backend is the user's Chrome: the ChatGPT extension in the Codex app's in-app browser (Owl) also reports family "chrome", so the model selects Chrome by id, with the instance ids MoPilot reads from the profiles.
//
// The plugin's agent.browsers.get("chrome") returns the first chrome-family extension backend in the unsorted
// listing of /tmp/codex-browser-use. The Codex desktop app installs the ChatGPT extension in its own in-app
// browser, whose native host serves a backend that reports type "extension" and family "chrome" too; when that
// one comes first, tabs fail with "Creating browser windows from extensions is not supported in Owl". The two
// differ only in their extensionInstanceId (minted per install, stored in the extension's Local Extension
// Settings leveldb) and in the profileName the plugin adds to an instance it finds in a Google Chrome profile.
// Read only: nothing here writes to Chrome's or Codex's files.
const { fs } = require('../../platform/ports/fs.cjs');
const os = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');
const { compareFilenameSequences } = require('../../../shared/filenameSequence.mjs');
const { CHROMIUM_BROWSERS, vendorChromeUserDataDirs } = require('./chromiumBrowsers.cjs');

/** The ChatGPT extension (Chrome Web Store), whose native host serves the plugin's Chrome backend. */
const CHATGPT_EXTENSION_ID = 'hehggadaopoacecdllhhajmbjkdcmajg';

/**
 * The plugin backend that is the user's Chrome, among agent.browsers.list() entries: a chrome-family extension
 * backend that is not a known Codex-app instance, preferring a known Chrome instance id, then one the plugin
 * found in a Chrome profile (profileName), then the only one left. Null when none qualifies. Its source is
 * also what the model runs (chromeSelectionNote), so it uses nothing outside itself.
 * @param {{ id: string, type?: string, family?: string, profileName?: string, metadata?: { extensionInstanceId?: string } }[]} list
 * @param {{ chrome: string[], codexApp: string[] }} known
 */
function pickChromeBackend(list, known) {
  const own = (b, ids) => ids.includes(b.metadata?.extensionInstanceId);
  const ext = list.filter((b) => b.type === 'extension' && (b.family ?? 'chrome') === 'chrome' && !own(b, known.codexApp));
  return ext.find((b) => own(b, known.chrome)) ?? ext.find((b) => b.profileName) ?? (ext.length === 1 ? ext[0] : null);
}

const UUID = /extensionInstanceId[\s\S]{0,8}?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/** The last extensionInstanceId a leveldb file's bytes hold (a later record overrides an earlier one), or null. */
function instanceIdIn(text) {
  /** @type {string | null} */
  let id = null;
  for (const m of String(text).matchAll(UUID)) id = m[1].toLowerCase();
  return id;
}

/**
 * The extension's instance id in one Local Extension Settings folder, read from its log and table files as
 * bytes (no leveldb reader): the newest file that names one wins. Null when the folder or the key is missing.
 */
function readInstanceId(f, dir) {
  let names;
  try {
    names = f.readdirSync(dir).filter((n) => /\.(?:log|ldb)$/.test(n));
  } catch (error) {
    noteIgnored("read the ChatGPT extension's settings folder", error, ['ENOENT', 'ENOTDIR']);
    return null;
  }
  // leveldb numbers its files in order: the highest is the newest
  names.sort(compareFilenameSequences).reverse();
  for (const name of names) {
    try {
      const id = instanceIdIn(f.readFileSync(path.join(dir, name)).toString('latin1'));
      if (id) return id;
    } catch (error) {
      // a file compacted away between listing and reading: the next one may still say it
      noteIgnored("read the ChatGPT extension's settings file", error, ['ENOENT']);
    }
  }
  return null;
}

/** The subfolders of `dir` (none when it can't be read). */
function subdirs(f, dir) {
  try {
    return f.readdirSync(dir);
  } catch {
    return [];
  }
}

const settingsOf = (profileDir) => path.join(profileDir, 'Local Extension Settings', CHATGPT_EXTENSION_ID);
const ids = (f, dirs) => [...new Set(dirs.map((d) => readInstanceId(f, settingsOf(d))).filter((id) => id !== null))];

/**
 * The ChatGPT extension's instance ids: in Google Chrome's profiles (the folder the plugin reads profile names
 * from, and the scratch profile in MOPILOT_CHROME_RELAY_USER_DATA_DIR, whose instance gets no profileName), and
 * in the Codex desktop app's in-app browser partitions (macOS). Empty lists when none is found.
 * @param {{ fs?: typeof fs, home?: string, platform?: string, env?: Record<string, string|undefined> }} [o]
 * @returns {{ chrome: string[], codexApp: string[] }}
 */
function chatgptExtensionInstances(o = {}) {
  const f = o.fs ?? fs;
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  // Google Chrome's folder (one on every platform), and the scratch profile MoPilot was pointed at
  const chromeDirs = vendorChromeUserDataDirs({ home, platform, env: o.env })
    .filter((b) => b.id === CHROMIUM_BROWSERS[0].id)
    .map((b) => b.dir);
  const profiles = chromeDirs.flatMap((dir) =>
    subdirs(f, dir)
      .filter((n) => n === 'Default' || /^Profile \d+$/.test(n))
      .map((n) => path.join(dir, n)),
  );
  const codexDir = path.join(home, 'Library', 'Application Support', 'Codex');
  const partitions =
    platform === 'darwin'
      ? subdirs(f, codexDir).flatMap((p) =>
          subdirs(f, path.join(codexDir, p, 'Partitions')).map((n) => path.join(codexDir, p, 'Partitions', n)),
        )
      : [];
  return { chrome: ids(f, profiles), codexApp: ids(f, partitions) };
}

const NOT_CONNECTED = "The user's Chrome is not connected to the Browser plugin";

/**
 * What a native Codex thread's model is told about selecting the user's Chrome in the Browser plugin: never
 * by the family name, but the entry pickChromeBackend chooses from agent.browsers.list(), with the
 * instance ids MoPilot read (`known`, or none).
 * @param {{ chrome: string[], codexApp: string[] } | null} [known]
 */
function chromeSelectionNote(known = null) {
  const k = { chrome: known?.chrome ?? [], codexApp: known?.codexApp ?? [] };
  const named =
    (k.chrome.length ? ` The user's Chrome has extensionInstanceId ${k.chrome.join(' or ')}.` : '') +
    (k.codexApp.length ? ` The Codex app's own browser has ${k.codexApp.join(' or ')}; never use it as Chrome.` : '');
  return (
    'Selecting Chrome in the Browser plugin: do not select it by its family name "chrome", even where the Chrome skill says to. ' +
    'The Codex desktop app\'s own browser (Owl) runs a copy of the ChatGPT extension that also reports family "chrome", and the family lookup returns whichever answers first; ' +
    'tabs there fail with "Creating browser windows from extensions is not supported in Owl". ' +
    // its helper names stay inside the function, so the program can run again in the same REPL
    `Select the user's Chrome by id instead (keep it in your persistent chrome binding): const chrome = await (async () => { const pick = ${pickChromeBackend.toString()}; ` +
    `const entry = pick(await agent.browsers.list(), ${JSON.stringify(k)}); if (!entry) throw new Error(${JSON.stringify(NOT_CONNECTED)}); return agent.browsers.get(entry.id); })();${named} ` +
    'The real Chrome is the chrome-family extension entry with a profileName. If no entry qualifies, tell the user their Chrome is not connected. ' +
    "If a tab still fails with the Owl error, that entry is the Codex app's browser: pick another chrome-family entry, or ask the user to quit the ChatGPT app or remove the ChatGPT extension from its own browser."
  );
}

/** Read vendor instance ids for a loaded thread's optional selection note without disrupting the thread. */
function readChromeInstances(read) {
  try {
    return read();
  } catch (error) {
    noteIgnored("read the ChatGPT extension's instance ids for a native Codex thread's note", error);
    return null;
  }
}

module.exports = {
  readChromeInstances,
  CHATGPT_EXTENSION_ID,
  pickChromeBackend,
  instanceIdIn,
  readInstanceId,
  chatgptExtensionInstances,
  chromeSelectionNote,
};
