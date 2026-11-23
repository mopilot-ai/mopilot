// Enable device-bound Touch ID only when this package was signed with its WebAuthn keychain group, and set up
// macOS's own passkey sheet (systemPasskeys.cjs), which serves Chrome-style iCloud and provider passkeys, phones and
// security keys when the package holds the web-browser passkey entitlement.
const { noteIgnored } = require('../../ignored.cjs');
const path = require('node:path');
const { proc: childProcess } = require('../../platform/ports/proc.cjs');
const { isEnabled } = require('../../platform/flags.cjs');
const { configureSystemPasskeys, loadPasskeyAddon } = require('./systemPasskeys.cjs');

/** The WebAuthn keychain group this package was signed with, read once per Info.plist (off main's event loop). */
/** @type {Map<string, Promise<string>>} */
const groups = new Map();
function webAuthnGroup(plist) {
  let group = groups.get(plist);
  if (!group) {
    group = new Promise((resolve, reject) =>
      childProcess.execFile(
        '/usr/bin/plutil',
        ['-extract', 'MPCWebAuthnAccessGroup', 'raw', '-o', '-', plist],
        { encoding: 'utf8', timeout: 10_000 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())),
      ),
    );
    groups.set(plist, group);
  }
  return group;
}

function configureBrowserAuth({
  app,
  session,
  dialog,
  BrowserWindow,
  webContents,
  browserWindows,
  // the app window showing a main-owned view tab: a window, null while the view is parked, undefined for any other page
  viewWindow = (_wc) => undefined,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  // the passkey bridge's native half
  loadAddon = () => loadPasskeyAddon({ platform, packaged: app.isPackaged, resourcesPath }),
}) {
  const state = { touchId: false };
  /** The window showing a page, where a passkey dialog goes: a view's (none while parked), else the page's own. */
  const pageWindow = (wc) => {
    const shown = viewWindow(wc);
    return shown !== undefined ? shown : BrowserWindow.fromWebContents(wc.getType() === 'webview' ? wc.hostWebContents : wc);
  };
  configureSystemPasskeys({
    load: loadAddon,
    enabled: () => isEnabled('shared.browser.systemPasskeys'),
    legacy: () => state.touchId,
    anchor: (wc) => (wc.isDestroyed() ? null : pageWindow(wc)),
  });
  /** @type {Promise<void>} */
  let ready = Promise.resolve();
  if (platform === 'darwin' && app.isPackaged && typeof app.configureWebAuthn === 'function') {
    // until it is read (milliseconds after launch) a passkey uses the normal alternate sign-in path
    ready = webAuthnGroup(path.resolve(resourcesPath, '..', 'Info.plist'))
      .then((group) => {
        if (!/^[A-Z0-9]{10}\.ai\.mopilot\.code\.webauthn$/.test(group)) return;
        app.configureWebAuthn({ touchID: { keychainAccessGroup: group, promptReason: 'sign in to $1' } });
        state.touchId = true;
      })
      .catch((error) => {
        // unsupported or unsigned packages keep the normal alternate sign-in path
        noteIgnored('set up Touch ID for passkeys in the browser', error);
      });
  }
  // not enumerable: the state goes to windows as it is (browser:pageState)
  Object.defineProperty(state, 'ready', { value: ready });

  session.on('select-webauthn-account', async (_event, details, callback) => {
    let selected;
    let cleanup = () => {
      /* nothing to clean up until a picker is shown */
    };
    try {
      const wc = details.frame && webContents.fromFrame(details.frame);
      const page = wc && browserWindows.owned(wc.id);
      if (!page || !details.accounts.length) return;
      const accounts = details.accounts.slice(0, 12);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const navigating = (event, _url, _inPlace, mainFrame) => {
        if (event.isMainFrame ?? mainFrame) cancel();
      };
      wc.once('destroyed', cancel);
      wc.on('did-start-navigation', navigating);
      cleanup = () => {
        wc.removeListener('destroyed', cancel);
        wc.removeListener('did-start-navigation', navigating);
      };
      const options = {
        type: 'question',
        title: 'Choose a passkey',
        message: `Sign in to ${details.relyingPartyId}`,
        detail: 'Choose the account you want to use with this passkey.',
        buttons: [...accounts.map((a) => a.displayName || a.name || 'Saved account'), 'Cancel'],
        cancelId: accounts.length,
        defaultId: accounts.length,
        noLink: true,
        signal: controller.signal,
      };
      // a parked view has no visible window to hang the picker on: it stands alone rather than behind a hidden one
      const parent = pageWindow(wc);
      const result = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
      if (!controller.signal.aborted && !wc.isDestroyed() && details.frame && !details.frame.isDestroyed())
        selected = accounts[result.response]?.credentialId;
    } catch {
      // Closing/navigating the page or a failed system dialog cancels this request.
    } finally {
      cleanup();
      try {
        callback(selected);
      } catch (error) {
        // the request may have been cancelled by navigation
        noteIgnored('answer a passkey account selection', error);
      }
    }
  });
  return state;
}

module.exports = { configureBrowserAuth };
