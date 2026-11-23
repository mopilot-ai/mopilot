// IPC for the app itself: usage-data consent, updates, notices, app info and diagnostics, the chat in view (and warming its harness on open), the theme.
const os = require('node:os');
const path = require('node:path');

const { systemUsername } = require('../../platform/userIdentity.cjs');
const { shareUsageDataEnabled } = require('../../../shared/usageData.mjs');
const { chatShownIn, parseView } = require('../../session/viewing.cjs');
const { createWarmOnOpen } = require('../../session/warmOnOpen.cjs');
const { claudeWarmOnOpen } = require('../../harness/claude/warmOnOpen.cjs');
/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; `live` reads (and sets) main's late-bound state
 */
function register(ipcMain, deps) {
  const { reportMigrationOnce, configureUpdates, shell, app, shellEnv, findCodexBinary, nativeTheme, viewedBy, live } = deps;
  // a chat opened gets its harness's process ready before it sends (#1830): Claude Code's CLI, when it had ended
  const warmOnOpen = createWarmOnOpen({
    hooks: {
      claude: {
        warm: async (chatId) =>
          !!live.claudeTurns &&
          claudeWarmOnOpen({ adapter: live.claudeTurns, api: deps.claude.turnApi, ref: (id) => live.controller.ref(id) }).warm(chatId),
      },
    },
    kindOf: (chatId) => live.controller?.ref(chatId)?.kind,
    shown: (chatId) => chatShownIn(viewedBy, deps.webContents, chatId),
    enabled: () => deps.isFlagEnabled('shared.prewarm'),
  });
  // a window brought back to the front on its chat warms it too (app/windows.cjs focus)
  live.warmOnOpen = warmOnOpen;
  app.on('will-quit', () => warmOnOpen.stop());
  // a choice the user made (Settings → Privacy): the only time the account is written
  ipcMain.handle('telemetry:consent', (_e, v) => {
    live.telemetry.setConsent(v);
    reportMigrationOnce();
    live.mopilot.setConsent(shareUsageDataEnabled(v));
  });
  ipcMain.handle('updates:state', () => live.updater.state);
  ipcMain.handle('updates:check', () => live.updater.check({ manual: true }));
  ipcMain.handle('updates:install', (_e, opts) => live.updater.install(opts));
  ipcMain.handle('updates:configure', (_e, opts) => configureUpdates(opts));
  ipcMain.handle('app:openNotices', () =>
    require('../../support/notices.cjs').openNotices({
      openPath: (p) => shell.openPath(p),
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
  );
  ipcMain.handle('app:info', async () => ({
    username: systemUsername(),
    version: app.getVersion(),
    platform: process.platform,
    home: os.homedir(),
    // where Codex keeps its state; older builds put worktrees under it
    codexHome: shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex'),
    codexBin: await findCodexBinary(),
    dark: nativeTheme.shouldUseDarkColors,
  }));
  ipcMain.handle('app:language', () => live.language.snapshot());
  // the same collector a bug report uses (electron/support/bugReport.cjs)
  ipcMain.handle('app:diagnostics', () => require('../../support/bugReport.cjs').collectDiagnostics(deps));
  // an error a window ignored on purpose (src/lib/ignored.ts): kept with main's for Copy diagnostics
  ipcMain.on('app:ignored', (_e, context, message) => {
    const { noteIgnored } = require('../../ignored.cjs');
    noteIgnored(`renderer: ${typeof context === 'string' ? context : 'unknown'}`, typeof message === 'string' ? message : 'unknown');
  });
  // the chats the window's panes show and the focused one (src/store/boot.ts windowView)
  ipcMain.handle('app:viewing', (e, raw) => {
    const before = viewedBy.get(e.sender.id);
    const view = parseView(raw);
    // a window on Home or a page reports no chat: a known, empty view, not an unknown one (its chats' deltas go slow)
    viewedBy.set(e.sender.id, view ?? { visible: [], primary: null, focused: null });
    // each chat that came on screen: one paused for a computer-use grant nobody was there to give gets its card now
    for (const chatId of view?.visible ?? [])
      if (!before?.visible.includes(chatId)) {
        live.computerUse?.onViewed(chatId);
        warmOnOpen.viewed(chatId);
      }
  });
  // a window holding an unsent draft keeps the app from restarting into an update by itself (app/stealthUpdate.cjs)
  ipcMain.handle('app:unsent', (e, has) => require('../unsent.cjs').report(e.sender, has));
  // the macOS Quick Actions: their status and switch, and the mopilot:// links they send
  require('../../platform/quickActionsWiring.cjs').register(ipcMain, deps);
  ipcMain.handle('app:setTheme', (_e, theme) => {
    nativeTheme.themeSource = theme;
  });
}

module.exports = { register };
