// IPC for ui-state, the chat store and the data migration (status, retry, report, restore).
const { ChatDeletion } = require('../../session/chatDeletion.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { within, deadline } = require('../../host/boundedWait.cjs');
const { createAutoArchive } = require('../autoArchive.cjs');
const { zoomLevelOf } = require('../../../shared/zoom.mjs');
const { permissionKey: codexPermissionKey } = require('../../harness/codexParams.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {import('../../main.cjs').IpcDeps} deps what main.cjs passes every IPC module; `live` reads (and sets) main's late-bound state
 */
function register(ipcMain, deps) {
  const {
    readState,
    registerChats,
    STATE_FILE,
    broadcastExcept,
    buildMenu,
    broadcastAll,
    retryMigration,
    app,
    migrationReport,
    restoreMigration,
    writeState,
    live,
  } = deps;
  ipcMain.handle('state:read', () => readState());
  const deletion = new ChatDeletion({
    store: live.chats,
    remove: {
      codex: async (target) => {
        // its file checkpoints go with it (session/turnCheckpoints.cjs): they keep old file contents from git's cleanup
        // a chat not opened since MoPilot started has its folder only on disk
        const cwd = live.codex.cwdOf?.(target.nativeId) ?? (await live.codex.folderOf?.(target.nativeId));
        const done = await live.codex.threadDelete(target.nativeId);
        if (cwd)
          await live.codex.turnChanges?.checkpoints
            ?.forget(target.nativeId, cwd)
            .catch((error) => noteIgnored("remove a deleted chat's file checkpoints", error));
        return done;
      },
      claude: (target) => deps.claude.deleteSession(target.nativeId),
      // a chat on another machine is stopped there first (best effort: a machine that is away keeps running it), then stops being followed, and its record of the machine goes (electron/host/wiring.cjs)
      acp: async (target) => {
        // a machine that does not answer is not waited for, and not for longer than one bound in all: the chat is deleted here and its deletion queued there.
        // The turn is stopped before the deletion is handed over; only the time left is shared
        const left = deadline();
        await within(
          Promise.resolve(live.remoteSend?.()?.stop(target.key)).catch((error) => noteIgnored('stop a deleted chat on its machine', error)),
          left(),
        );
        const remoteDeletion = await live.remoteForget?.(target.key, left());
        await live.acpHost.remove(target.key);
        return remoteDeletion;
      },
    },
    broadcast: (receipt) => broadcastAll('chats:deleted', receipt),
  });
  // the orchestration journal hooks onDeleted once it starts (app/orchestration.cjs)
  live.chatDeletion = deletion;
  ipcMain.handle('chats:delete', async (_e, id) => {
    const result = await deletion.delete(id);
    try {
      live.audioOwnership?.delete(id, result.nativeKeys);
      await live.audioOwnership?.collect();
    } catch (error) {
      noteIgnored('collect audio after the chat was already deleted', error);
    }
    return result;
  });
  ipcMain.handle('chats:deletions', () => deletion.snapshot());
  // Settings → General → Automatically archive inactive chats: main sweeps, with or without a window open
  const autoArchive = createAutoArchive({ live, readState, broadcastAll, claude: deps.claude });
  autoArchive.start();
  // a linked session's parent archives it the same way, after the user said yes (orchestration archive_session)
  live.archiveChat = (chatId) => autoArchive.archive(chatId);
  let codexPrefs = codexPermissionKey(readState()?.prefs);
  // a prefs change main makes (Chrome's side panel picks a permission or model) is heard as a window's is
  live.patchPrefs = registerChats(ipcMain, {
    store: live.chats,
    uiState: STATE_FILE(),
    broadcast: broadcastExcept,
    runOnName: (id) => live.runOnName?.(id),
    onPrefs: (prefs) => {
      live.scheduler?.settingsChanged(prefs?.schedulerOff !== true);
      autoArchive.settingsChanged();
      // Reconsider retained linked input when settings change; recipients keep their own ordering.
      live.orchestrator?.pump();
      // MoMo paused or resumed: its routine runs stop (electron/app/momoBackground.cjs)
      live.momo?.prefsChanged(prefs);
      // and paired phones hear when what they show of MoMo's settings changed (remote/momoOps.cjs)
      live.momoRemote?.prefsChanged(prefs);
      if (prefs?.notifyOnComplete) live.notifyMode = prefs.notifyOnComplete;
      if (prefs?.notifyKinds) live.notifyKinds = prefs.notifyKinds;
      // new quiet hours may have ended the ones in force: what waited is said now
      void live.notifier?.quietChanged();
      // a new permission reaches live Claude CLIs now, mid-turn too (Claude in Chrome follows the session's mode)
      // permissionChanged handles each session's failure itself
      live.claudeTurns?.permissionChanged().catch((error) => noteIgnored('give live Claude Code sessions a new permission mode', error));
      // and a running Codex goal whose chat has no permission of its own, for its next turns (the adapter tells a failure)
      const codexKey = codexPermissionKey(prefs);
      if (codexKey !== codexPrefs)
        Promise.resolve(live.codex?.permissionChanged()).catch((error) => noteIgnored('give running Codex goals a new permission', error));
      codexPrefs = codexKey;
      // the user's own MCP servers turned on or off for a basic harness reach its process (harness/acp/ownMcp.cjs)
      live.acpOwnMcp?.changed();
      // a new zoom level (View → Zoom In, Zoom Out, Actual Size, from any window) goes to every window
      deps.zoom.set(zoomLevelOf(prefs));
      // rebinding a menu action moves its accelerator, and a new language renames every menu
      const kb = prefs?.keybindings || {};
      const languageChanged = live.language?.refresh();
      if (languageChanged || JSON.stringify(kb) !== JSON.stringify(live.menuKeybindings)) {
        live.menuKeybindings = kb;
        buildMenu();
      }
    },
  }).patchPrefs;
  ipcMain.handle('migration:status', () => (live.cookieStatus ? [...live.migration, live.cookieStatus] : live.migration));
  const reloadChats = (done) => {
    const candidate = Object.assign(Object.create(Object.getPrototypeOf(live.chats)), live.chats, {
      fallback: !done,
      records: new Map(),
      archiveEpochs: new Map(
        [...new Set([...live.chats.archiveEpochs.keys(), ...live.chats.records.keys()])].map((id) => [id, live.chats.archiveEpoch(id)]),
      ),
      newer: new Set(),
      unreadable: new Set(),
    });
    try {
      candidate.load();
      if (!deletion.admitReload(candidate.records)) throw new Error('A retired chat identity changed ownership');
    } catch (error) {
      throw new Error(
        'Migration was attempted; any file changes remain on disk. This process kept its previous chat snapshot. Restart is required to activate any changed data.',
        { cause: error },
      );
    }
    for (const key of ['fallback', 'records', 'newer', 'unreadable', 'archiveEpochs']) live.chats[key] = candidate[key];
    Promise.resolve(live.claudeTurns?.permissionChanged()).catch((error) =>
      noteIgnored('reconcile live Claude permissions after chat reload', error),
    );
    deletion.refreshAliases();
    live.controller.invalidate();
    broadcastAll('chats:reset', live.chats.snapshot());
  };
  ipcMain.handle('migration:retry', () => {
    if (deletion.pending.size) throw new Error('Wait for chat deletion to finish before retrying migration');
    live.chats.flush();
    let r;
    try {
      r = retryMigration(app.getPath('userData'), '2026-10-threads-v2', { appVersion: app.getVersion() });
    } finally {
      // even a migration that failed partway may have written the file
      live.chats.releaseUiState();
    }
    live.migration = r ? [r] : live.migration;
    reloadChats(r && (r.result === 'ok' || r.result === 'done'));
    return live.migration;
  });
  ipcMain.handle('migration:report', () => migrationReport(app.getPath('userData')));
  // Settings → About → Restore pre-migration data: back to the legacy files; chats are served from them until a Retry
  ipcMain.handle('migration:restore', () => {
    if (deletion.pending.size) throw new Error('Wait for chat deletion to finish before restoring migration');
    live.chats.flush();
    let r;
    try {
      r = restoreMigration(app.getPath('userData'), '2026-10-threads-v2', { appVersion: app.getVersion() });
    } finally {
      live.chats.releaseUiState();
    }
    if (!r) return null;
    live.migration = [{ id: r.id, result: 'restored', report: r.report }];
    reloadChats(false);
    return live.migration;
  });
  ipcMain.handle('state:write', (_e, s) => writeState(s));
}

module.exports = { register };
