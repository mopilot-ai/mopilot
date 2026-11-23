// The app's lifecycle: setup before 'ready' (profile, cookies, crash reports, one instance), protocol and permissions, quitting.
const { createAssetHandler } = require('../platform/assetProtocol.cjs');
const { APP_NAME, STORAGE_NAME, userDataDir, migrateUserData, lastEntry, record, readRegistry } = require('../migrations/migrate.cjs');
/** How many times a failing cookie re-encryption is tried, one per start. */
const REENCRYPT_TRIES = 3;
/** How long quitting waits for the harnesses, remote side chats and other services to finish cleanup. */
const QUIT_CLEANUP_MS = 3000;
/** How long a committed quit may take before the app exits regardless (a window held open by a native sheet, #3977). */
const QUIT_DEADLINE_MS = 10000;
const cookieMigration = require('../migrations/2026-10-cookies.cjs');
const { Telemetry, harnessVersions, REPORT_MARKER } = require('../support/telemetry.cjs');
const { ownsAppWindow } = require('../platform/windowRecovery.cjs');
const { shareableChatsIn } = require('../../shared/momoChat.mjs');
const { updateChannel } = require('../updates/channel.cjs');
const { installId, reportsToService } = require('../platform/install.cjs');
const { InstallPing } = require('../support/installPing.cjs');
const { holdQuit, cleanupHold, quitDeadline } = require('../platform/exitGate.cjs');
const { installerQuitHold } = require('./installerQuit.cjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { keepPrivate, tightenTree } = require('../platform/privateFiles.cjs');
const { observe } = require('../../shared/observations.cjs');
const { accountScope } = require('../remote/accountScope.cjs');
const { listenForLinks } = require('../platform/openLinks.cjs');
const { desktop } = require('../../shared/edition.json');

/**
 * @param {import('../main.cjs').LifecycleDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function createLifecycle({
  app,
  protocol,
  session,
  net,
  globalShortcut,
  isWin,
  claude,
  pty,
  server,
  readState,
  appWindows,
  menus,
  chatSessions,
  live,
}) {
  const { showMainWindow } = appWindows;
  const quitting = new AbortController();
  /** Before 'ready': the codex-asset scheme, the app's name and id, and its user data folder (moved from the old name). */
  function prepareApp() {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'codex-asset', privileges: { standard: false, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
    ]);
    // Electron configures macOS Keychain and Linux keyring encryption from this name before 'ready'.
    // Restore the display name in onReady, after that configuration, keeping saved secrets and cookies readable.
    app.setName(STORAGE_NAME);
    // macOS hands over mopilot:// links (the Quick Actions') as 'open-url', possibly before 'ready' (other systems never emit it)
    listenForLinks(app);
    // Windows attributes notifications and taskbar pinning by this id; the installer's shortcuts carry the same one.
    if (isWin) app.setAppUserModelId(desktop.appId);
    {
      const dir = userDataDir(app.getPath('appData'));
      if (!process.env.MOPILOT_USER_DATA && !process.env.SAGE_USER_DATA) migrateUserData(app.getPath('appData'), dir);
      app.setPath('userData', dir);
      // everything MoPilot writes there through fsutil is owner-only (privateFiles.cjs)
      keepPrivate(dir);
    }
  }

  /* Built-in browser cookies from the pre-rebrand app: decrypted before Chromium opens them (D-83). */
  /** @type {{ id: string, result: string, reason: string } | null} */
  let cookieStatus = null;
  let cookieReencrypt = false;
  /** Before 'ready': built-in browser cookies from the pre-rebrand app are decrypted before Chromium opens them. */
  function migrateCookies() {
    if (!desktop.legacyProfiles.length) return;
    const ud = app.getPath('userData');
    const done = lastEntry(ud, cookieMigration.id);
    // macOS keychain keys only; Windows profiles never had the pre-rebrand app's cookies
    if (!done && !isWin) {
      try {
        const r = cookieMigration.migrateCookies(ud);
        record(ud, {
          id: cookieMigration.id,
          result: r.result,
          decrypted: r.decrypted,
          failed: r.failed,
          reencrypt: r.reencrypt,
          backup: r.backup,
          at: Date.now(),
        });
        cookieReencrypt = r.reencrypt;
        if (r.result === 'failed') cookieStatus = { id: cookieMigration.id, result: 'failed', reason: `${r.failed} cookies` };
      } catch (e) {
        record(ud, { id: cookieMigration.id, result: 'error', message: e?.message ?? String(e), at: Date.now() });
        cookieStatus = { id: cookieMigration.id, result: 'error', reason: e?.message ?? String(e) };
      }
    } else if (done?.reencrypt) {
      // a re-encryption that failed is tried again at the next start, a few times
      const id = `${cookieMigration.id}-reencrypt`;
      const registry = readRegistry(ud);
      const tries = registry.filter((e) => e?.id === id);
      cookieReencrypt = tries.at(-1)?.result !== 'ok' && tries.length < REENCRYPT_TRIES;
      // once re-encrypted, or out of tries, no plaintext of step 1 stays: plain cookies go and freed pages are scrubbed
      const scrub = `${cookieMigration.id}-scrub`;
      const scrubs = registry.filter((e) => e?.id === scrub);
      const over = tries.at(-1)?.result === 'ok' || tries.length >= REENCRYPT_TRIES;
      // a scrub that failed is tried again at the next starts, as many times as a re-encryption
      if (over && scrubs.at(-1)?.result !== 'ok' && scrubs.length < REENCRYPT_TRIES)
        try {
          const plain = cookieMigration.scrubDbs(ud, done.backup);
          record(ud, { id: scrub, result: 'ok', plain, at: Date.now() });
        } catch (e) {
          record(ud, { id: scrub, result: 'error', message: messageOf(e), at: Date.now() });
        }
    }
  }

  /** The migration counts go out once, the first time usage sharing is on (electron/support/telemetry.cjs migrationReport). */
  function reportMigrationOnce() {
    try {
      const ud = app.getPath('userData');
      if (telemetry?.reportMigration(readRegistry(ud))) record(ud, { id: REPORT_MARKER, result: 'sent', at: Date.now() });
    } catch (error) {
      // telemetry is best effort; it tries again next start
      noteIgnored('report the data migrations', error);
    }
  }

  /** Usage data (on unless turned off): crash reporting has to start before 'ready' to catch early crashes. */
  /** @type {InstanceType<typeof Telemetry>} assigned while main.cjs loads */
  let telemetry;
  /** @type {InstanceType<typeof InstallPing>} assigned with telemetry; startup starts it once sign-in is loaded */
  let installPing;
  function startTelemetry() {
    const p = readState().prefs || {};
    const ud = app.getPath('userData');
    const channel = () => updateChannel(readState().prefs?.updateChannel, !!live.mopilot?.status().user?.internal);
    const accessToken = () => live.mopilot?.accessToken() ?? Promise.resolve(null);
    const reports = reportsToService(app.isPackaged);
    installPing = new InstallPing({
      userData: ud,
      installId: installId(ud),
      version: app.getVersion(),
      channel,
      signedIn: () => live.mopilot?.status().signedIn ?? null,
      sharing: () => telemetry.consent,
      accessToken,
      reports,
    });
    telemetry = new Telemetry({
      userData: ud,
      installId: installId(ud),
      channel,
      accessToken,
      reports,
      version: app.getVersion(),
      account: () => live.mopilot?.status().user?.id ?? null,
      owner: () => live.mopilot?.creds ?? null,
      scope: () => accountScope(live.mopilot),
      shareableChat: shareableChatsIn(live),
      versions: async () =>
        harnessVersions({
          codexUserAgent: live.codex?.init
            ? (await live.codex.init.catch((error) => (noteIgnored('read the Codex version for a report', error), null)))?.userAgent
            : null,
          claude: claude.version(),
          admission: live.acpAdmission?.list() ?? [],
        }),
    });
    telemetry.startCrashReporter(p.shareUsageData);
    process.on('uncaughtException', (err) => {
      console.error(err);
      telemetry.error({ message: err?.message, stack: err?.stack, process: 'main', kind: 'uncaught' });
    });
    process.on('unhandledRejection', (/** @type {any} */ err) =>
      telemetry.error({ message: err?.message ?? String(err), stack: err?.stack, process: 'main', kind: 'unhandledrejection' }),
    );
    app.on(
      'render-process-gone',
      (_e, wc, d) =>
        d.reason !== 'clean-exit' &&
        // an app window's renderer is reported by its recovery (platform/windowRecovery.cjs), its window named
        !ownsAppWindow(wc) &&
        telemetry.error({ message: `renderer gone: ${d.reason} (${d.exitCode})`, process: 'renderer', kind: 'process-gone' }),
    );
    app.on(
      'child-process-gone',
      (_e, d) =>
        d.reason !== 'clean-exit' &&
        telemetry.error({ message: `${d.type} gone: ${d.reason} (${d.exitCode})`, process: d.type, kind: 'process-gone' }),
    );
  }

  /**
   * One app instance per profile: a second launch focuses the app window we already have (never Quick Chat). Taken
   * before the cookie migration, so a second launch never touches databases the running app's Chromium has open.
   */
  function singleInstance() {
    if (!app.requestSingleInstanceLock()) app.exit(0);
    app.on('second-instance', () => {
      if (app.isReady()) showMainWindow();
    });
  }

  /** At 'ready': carried-over cookies re-encrypted, local images served, and the permissions windows may use. */
  function onReady() {
    app.setName(APP_NAME);
    // what an earlier version left readable by other users is made owner-only, off the startup path
    tightenTree(app.getPath('userData')).catch((error) => noteIgnored('make the data folder private', error));
    if (cookieReencrypt) {
      // store the carried-over (and any plaintext) cookies with this build's key
      const ud = app.getPath('userData');
      const id = `${cookieMigration.id}-reencrypt`;
      // a session that fails is recorded as an error, so the next start tries again instead of counting it done
      Promise.allSettled([session.defaultSession, session.fromPartition('persist:browser')].map((s) => cookieMigration.reencryptSession(s)))
        .then((all) => {
          const cookies = all.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value : 0), 0);
          const failed = all.find((r) => r.status === 'rejected');
          record(
            ud,
            failed
              ? { id, result: 'error', cookies, message: messageOf(failed.reason), at: Date.now() }
              : { id, result: 'ok', cookies, at: Date.now() },
          );
        })
        .catch((error) => noteIgnored('record the cookie re-encryption', error));
    }
    // Images and local media share MIME admission and preserve Range requests for seeking.
    protocol.handle('codex-asset', createAssetHandler(net, isWin));
    // Only the microphone (voice mode) and clipboard are requested by the renderer.
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      ['media', 'local-fonts', 'clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission),
    );
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      if (permission === 'media') {
        const { mediaTypes } = /** @type {Electron.MediaAccessPermissionRequest} */ (details);
        return cb(!mediaTypes || mediaTypes.every((t) => t === 'audio'));
      }
      cb(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'local-fonts'].includes(permission));
    });
  }

  /** Quitting: the gate asks first, then every process main started stops. */
  function handleQuit() {
    const quitCleanup = cleanupHold(QUIT_CLEANUP_MS);
    const installerCleanup = installerQuitHold();
    const deadline = quitDeadline(QUIT_DEADLINE_MS, (code) => app.exit(code));
    /** @type {Promise<void> | null} computer use giving the Mac back before the quit goes on */
    let givingBack = null;
    app.on('window-all-closed', () => {
      // the tray icon keeps the app running on Windows, as the Dock does on macOS
      if (process.platform !== 'darwin' && !menus.tray) app.quit();
    });
    app.on('before-quit', (e) => {
      // with the Dock icon hidden for Mobile Remote, the gate's question needs somewhere to show
      live.alwaysOn?.surface();
      // the gate asks first when quitting would stop turns, background tasks or goals
      if (holdQuit(e, live.exitGate, () => app.quit())) return;
      // the quit is committed: from here it ends within the deadline, whatever a window still holds open
      deadline({ stillQuitting: () => !live.exitGate || live.exitGate.passed });
      quitting.abort();
      live.alwaysOn?.close();
      if (installerCleanup(e, require('./ipc/harnessRuns.cjs').runsFor(app), live.acpAdmission?.registry, () => app.quit())) return;
      // the quit is confirmed: no window waits on screen for the cleanup below (the gate's dialog was in one)
      appWindows.hideAll();
      // computer use gives the Mac back first (held keys, hidden apps, the user's clipboard), while its helper still
      // runs; a second quit meanwhile waits for the same give-back instead of stopping the helper under it
      if (givingBack || live.computerUse?.holding?.()) {
        e.preventDefault();
        // (holding() said so, so computer use is set up)
        givingBack ??= /** @type {NonNullable<typeof live.computerUse>} */ (live.computerUse).letGo().finally(() => {
          givingBack = null;
          setImmediate(() => app.quit());
        });
        return;
      }
      // the CLIs can close their Chrome tab groups and the Host can retire temporary chats before disconnecting
      if (
        quitCleanup(
          e,
          // chat transcripts, the tool operation log and MoMo's trust files still queued in the background go to disk
          () => [
            claude.closeAll(),
            live.chromeChannel?.stopAll(),
            live.acpHost?.items?.drain(),
            live.transcripts.drain(),
            live.momo?.close(),
            live.remote?.close(),
            live.retireHostSideChats?.(QUIT_CLEANUP_MS),
          ],
          () => app.quit(),
        )
      )
        return;
      for (const id of [...chatSessions.rolloutWatchers.keys()]) chatSessions.unwatchRollout(id);
      live.accounts?.dispose();
      live.updater?.dispose();
      observe({ kind: 'lifecycle', action: 'quitting' });
      telemetry?.persist();
      server.stop();
      live.acpHost?.closeAll();
      pty.killAll();
      live.computerUse?.stop();
      live.devPreviews?.stopAll({ preserveSaved: true });
      live.browserShim?.close();
      // the browser history kept in memory is saved, sealed
      live.browserData?.close();
      // the state held in memory and written behind (chats, prefs, context, the orchestration journal) reaches the disk
      live.chats?.flush();
    });
    app.on('will-quit', () => {
      quitting.abort();
      globalShortcut.unregisterAll();
    });
  }

  return {
    get quitSignal() {
      return quitting.signal;
    },
    prepareApp,
    migrateCookies,
    startTelemetry,
    reportMigrationOnce,
    singleInstance,
    onReady,
    handleQuit,
    get cookieStatus() {
      return cookieStatus;
    },
    /** @returns {InstanceType<typeof Telemetry>} */
    get telemetry() {
      return telemetry;
    },
    /** @returns {InstanceType<typeof InstallPing>} */
    get installPing() {
      return installPing;
    },
  };
}

module.exports = { createLifecycle };
