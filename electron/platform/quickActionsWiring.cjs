// The macOS Quick Actions' main-process wiring (registered by electron/app/ipc/app.cjs): whether they are installed in ~/Library/Services, the Settings switch that installs or removes them (never automatic), and the opening of the mopilot:// links they send.
const { createQuickActions, bundleOf } = require('./quickActions.cjs');
const { inbox } = require('./openLinks.cjs');
const { createLinkOpener } = require('./quickActionLinks.cjs');

/**
 * @param {unknown} _ipcMain
 * @param {{ app: { isPackaged: boolean, getPath(name: string): string }, readyMainWindow: () => Promise<any>, handle: (channel: string, fn: (...args: any[]) => unknown) => void }} deps
 * @param {{ actions?: ReturnType<typeof createQuickActions>, platform?: string }} [o] tests pass their own
 */
function register(_ipcMain, deps, o = {}) {
  const { app, handle, readyMainWindow } = deps;
  const actions =
    o.actions ??
    createQuickActions({ appPath: app.isPackaged && (o.platform ?? process.platform) === 'darwin' ? bundleOf(app.getPath('exe')) : null });
  // only while the user has the Quick Actions turned on (a web page's mopilot:// link is otherwise ignored)
  inbox.setHandler(createLinkOpener({ readyMainWindow, enabled: () => ['on', 'stale'].includes(actions.status().state) }));
  handle('quickActions:status', () => actions.status());
  handle('quickActions:set', (on) => (on === true ? actions.install() : actions.uninstall()));
}

module.exports = { register };
