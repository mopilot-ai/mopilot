// Loaded into the app's main process before it starts (Electron's -r) on Linux, where the PR check runs most E2E specs on
// a runner's virtual display: it stands in for what a Linux desktop has and the runner does not. tests/e2e/fixtures/app.ts
// loads it there, with Chromium's basic password store (--password-store=basic).
// - No keyring: safeStorage would say it cannot encrypt, and the app keeps no API key, account or sealed history. With
//   plain-text encryption on, it encrypts with Chromium's fixed key. This fake reports a keyring backend so app-flow specs
//   can persist their fake accounts. It validates neither encryption nor Linux keyring integration: production rejects basic_text,
//   and the packaged Linux check runs against a real temporary keyring without this preload.
// - No notification server: Notification.isSupported() says no, and the app shows none. Background mode
//   (electron/app/backgroundMode.cjs) already keeps a shown one off the screen, and the specs that read them record show.

/**
 * @param {{ safeStorage: { setUsePlainTextEncryption(plain: boolean): void, getSelectedStorageBackend(): string }, Notification: { isSupported(): boolean } }} electron
 */
function standInForDesktop({ safeStorage, Notification }) {
  safeStorage.setUsePlainTextEncryption(true);
  safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
  Notification.isSupported = () => true;
}

module.exports = { standInForDesktop };
// the app's main process (Electron's -r): child processes that load this file get nothing
if (process.type === 'browser') standInForDesktop(require('electron'));
