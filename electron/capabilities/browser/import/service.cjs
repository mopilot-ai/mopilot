// Builds the browser importer from the real readers (Chromium family, Safari), the key reader, the history, bookmark and login stores and the shared session.
const os = require('node:os');
const path = require('node:path');
const { BrowserImporter } = require('./importer.cjs');
const { listSources } = require('./sources.cjs');
const { chromiumKey } = require('./chromiumKey.cjs');
const { ImportLedger } = require('./cookies.cjs');
const chromium = require('./chromium.cjs');
const safari = require('./safari.cjs');
const { readPasswordsCsv } = require('./passwordCsv.cjs');
const { ImportError } = require('./errors.cjs');

/**
 * @param {{ userData: () => string, data: ReturnType<typeof import('../data.cjs').createBrowserData>, logins: () => InstanceType<typeof import('../credentialStore.cjs').CredentialStore>, session: () => any, broadcast: (channel: string, payload: any) => void, home?: string, platform?: NodeJS.Platform, execFile?: Function }} o
 *   userData: the app's user data folder (the ledger lives there)
 *   data: the history and bookmark stores
 *   logins: MoPilot's own login store, where imported passwords go
 *   session: the shared profile's Electron session
 *   execFile: runs the keychain command (tests give a fake)
 */
function createImporter({ userData, data, logins, session, broadcast, home = os.homedir(), platform = process.platform, execFile }) {
  return new BrowserImporter({
    sources: () => listSources({ home, platform }),
    readers: {
      chromium: {
        bookmarks: (profile) => chromium.readBookmarks(profile.path),
        history: (profile) => chromium.readHistory(profile.path),
        cookies: (profile, key) => chromium.readCookies(profile.path, key),
        passwords: (profile, key) => chromium.readPasswords(profile.path, key),
      },
      safari: {
        bookmarks: () => safari.readBookmarks({ home }),
        history: () => safari.readHistory({ home }),
        cookies: () => safari.readCookies({ home }),
        // Safari's passwords: the file the user exported from Safari (File → Export → Passwords)
        passwords: async (_profile, _key, { file }) => {
          if (!file) throw new ImportError('no_file', 'Choose the passwords file Safari exported.');
          return readPasswordsCsv(file);
        },
      },
    },
    key: (service) => chromiumKey(service, { platform, execFile }),
    history: data.history,
    bookmarks: data.bookmarks,
    session,
    logins,
    ledger: new ImportLedger({ file: path.join(userData(), 'browser-import.json') }),
    broadcast,
  });
}

module.exports = { createImporter };
