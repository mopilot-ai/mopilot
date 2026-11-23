// Background mode for test instances (SAGE_E2E_BACKGROUND=1): windows open without taking focus, no Dock icon, no OS notifications.

/**
 * Lets an E2E run go on behind whatever the user is doing. The E2E fixture sets SAGE_E2E_BACKGROUND=1 for every app
 * it launches; a person who wants to watch a run sets SAGE_E2E_FOREGROUND=1 instead (tests/e2e/fixtures/app.ts).
 * @param {{ app: Electron.App, BrowserWindow: typeof Electron.BrowserWindow, Notification: typeof Electron.Notification, env?: Record<string, string | undefined> }} deps
 * @returns {boolean} whether background mode is on
 */
function applyBackgroundMode({ app, BrowserWindow, Notification, env = process.env }) {
  if (env.SAGE_E2E_BACKGROUND !== '1') return false;
  // Every show and focus in main goes through these, so no window, menu command or notification click a test
  // triggers can bring the app to the front. The specs do not depend on window focus (tests/e2e/playwright.config.ts).
  BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive;
  BrowserWindow.prototype.focus = () => undefined;
  // macOS: no Dock icon, and the app is not activated when it starts
  app.dock?.hide();
  // an unfocused app would post a banner for every finished turn; a spec that reads them replaces show itself
  Notification.prototype.show = () => undefined;
  return true;
}

module.exports = { applyBackgroundMode };
