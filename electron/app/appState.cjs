// ui-state.json as main reads and writes it (the prefs windows save), and the chat store, opened after the data migrations.
const path = require('node:path');
const { runMigrations } = require('../migrations/migrate.cjs');
const {
  ChatsStore,
  peekUiState,
  dropUiState,
  setSaveFailureNotice,
  writeRendererState,
  migrateDefaultHarness,
  settleWelcome,
  patchPrefs,
} = require('../platform/chats.cjs');
const { legacyZoomPatch } = require('../../shared/zoom.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { branchPrefixOf } = require('../../shared/branchPrefix.mjs');
const { forgetHandoffs } = require('../capabilities/browser/handoffPages.cjs');
const { momoModelOf } = require('../../shared/momoChat.mjs');
const { createChatMetaBroadcast } = require('./chatMetaBroadcast.cjs');
const { permissionKey: codexPermissionKey } = require('../harness/codexParams.cjs');
const { openLanguage } = require('./language.cjs');

/**
 * @param {import('../main.cjs').AppStateDeps} deps what main.cjs passes in; `live` reads the services an archived chat lets go of
 */
function createAppState({ app, isFlagEnabled, claude, live, broadcast, dialog }) {
  const STATE_FILE = () => path.join(app.getPath('userData'), 'ui-state.json');
  /** @returns {Record<string, any>} Read-only state, as main holds it (written behind: electron/platform/uiStateFile.cjs). */
  function readState() {
    return peekUiState(STATE_FILE());
  }
  // All local harnesses use the setting from this app launch, including headless work.
  let preferHighestCli = false;
  live.language = openLanguage({ app, readState });
  /* Per-chat state (threads/<id>.v2) and prefs are written only here (electron/platform/chats.cjs). */
  /** @type {InstanceType<typeof ChatsStore>} assigned at startup, before any window or IPC handler uses it */
  let chats;
  /** @type {Array<{ id: string, result: string, [key: string]: unknown }>} */
  let migration = [];
  function writeState(s) {
    try {
      writeRendererState(STATE_FILE(), s);
    } catch (error) {
      // the window sends its whole state again on its next change
      noteIgnored("save the windows' state", error);
    }
  }
  // a state file that keeps failing to save (disk full, no permission) is shown once, so the user is not left thinking it is kept
  setSaveFailureNotice((file) => {
    Promise.resolve(
      dialog?.showMessageBox({
        type: 'warning',
        message: "MoPilot can't save its settings",
        detail: `${path.basename(file)} could not be written. Free some disk space or check the folder's permissions; changes since then are kept until you quit.`,
      }),
    ).catch((error) => noteIgnored('tell that the app state could not be saved', error));
  });
  /** Run the data migrations (before any window opens), then open the chat store on the result. */
  function openChats() {
    try {
      // what the migrations read and write is the disk's: nothing held from before them
      dropUiState(STATE_FILE());
      migration = runMigrations(app.getPath('userData'), { appVersion: app.getVersion() });
      dropUiState(STATE_FILE());
    } catch (e) {
      console.error('migration failed', e);
      migration = [{ id: 'threads-v2', result: 'error', message: e?.message ?? String(e) }];
    }
    try {
      migrateDefaultHarness(STATE_FILE());
    } catch (error) {
      // the old prefs stay as they were: the window moves them as it loads (src/store/boot.ts), or the next start does
      noteIgnored('move the default harness to its one setting', error);
    }
    try {
      // the chat font size the old font size shortcuts left becomes the zoom level (shared/zoom.mjs)
      const legacy = legacyZoomPatch(readState().prefs);
      if (legacy) patchPrefs(STATE_FILE(), legacy, []);
    } catch (error) {
      // the window keeps the old size as its chat font size; main zooms as the old size asked (zoomLevelOf)
      noteIgnored('move the font size the old shortcuts set to the zoom level', error);
    }
    try {
      settleWelcome(STATE_FILE());
    } catch (error) {
      // unsettled, the window reads the default (done): a new install is welcomed only while nothing works
      noteIgnored('settle whether the welcome page was finished', error);
    }
    preferHighestCli = readState().prefs?.preferHighestCli === true;
    const done = migration.length > 0 && migration.every((m) => m.result === 'ok' || m.result === 'done');
    // late: the windows are made after the chat store opens
    const metaHeard = createChatMetaBroadcast({
      broadcast: (id, chat) => broadcast('chats:changed', { id, chat }),
      get: (id) => chats.get(id),
      failed: noteIgnored,
    });
    const permissionKeys = new Map();
    const permissionKey = (meta) => JSON.stringify([meta?.config?.permission ?? null, meta?.config?.model ?? null, momoModelOf(meta)]);
    // what a running Codex goal's thread settings are made of
    const codexKeys = new Map();
    const codexKey = (meta) => codexPermissionKey(meta?.config);
    chats = new ChatsStore(path.join(app.getPath('userData'), 'threads'), {
      uiState: STATE_FILE(),
      fallback: !done,
      legacyMirror: () => isFlagEnabled('data.legacyMirror'),
      onChange: (id, v) => {
        live.controller?.invalidate();
        metaHeard.changed(id, v);
        // a paired phone's list changes with it
        live.chromePanel?.service?.onChatsChanged();
        const key = permissionKey(v?.meta);
        const before = permissionKeys.get(id) ?? permissionKey(null);
        permissionKeys.set(id, key);
        if (v && key !== before && typeof v.meta?.archived !== 'number')
          Promise.resolve(live.claudeTurns?.permissionChanged(id)).catch((error) =>
            noteIgnored("apply a chat's saved Claude Code permission", error),
          );
        const codex = codexKey(v?.meta);
        const had = codexKeys.get(id) ?? codexKey(null);
        codexKeys.set(id, codex);
        // a Codex goal's next turns start on its thread's settings: a running one takes the change now; the adapter tells a failure
        if (v && codex !== had && typeof v.meta?.archived !== 'number')
          Promise.resolve(live.codex?.permissionChanged(id)).catch((error) =>
            noteIgnored("apply a chat's permission to its Codex goal", error),
          );
        // an archived or deleted chat's last tool surface (a phone's surface.current) is not kept
        if (!v || typeof v.meta?.archived === 'number') {
          live.capabilities?.forgetSurface(id);
          // and its phantom cursor's remembered positions
          live.computerUse?.visibility?.forget(id);
        }
        if (!v) live.chromePanel?.forgetChat(id);
        // an archived chat (from any window or harness) drops its desktop control grants, its idle Claude CLIs end,
        // and the dev servers it started stop
        if (typeof v?.meta?.archived === 'number') {
          // grants of an archived chat expire anyway
          live.computerUse?.desktop?.forget(id).catch((error) => noteIgnored("drop an archived chat's desktop control grants", error));
          claude.retireChat(id);
          live.acpHost?.retireChat(id);
          // its Your Chrome instance ends (closing its tab group) once its calls and turn end, on any harness
          live.chromeChannel?.release(id);
          // its tabs in the user's Chrome over MoPilot's extension or relay leave its group, the user's again (at the
          // end of a turn that still runs: archiving doesn't stop it)
          live.chromeRelay?.tabs.release(id);
          live.devPreviews?.stopChat(id);
          live.browserShim?.forget(id);
          // the sites it handed to the user's Chrome for a sign-in (browser/handoffPages.cjs)
          forgetHandoffs(id);
          // the tabs its agent left open (kept past their windows by design) close, and its sites' consents go, before
          // its browser storage is cleared under pages still running in it
          live.hostTabs?.forget(id);
          live.browserGrants?.forget(id);
          // the chat's own browser storage (Settings → Browser → Storage: This chat only) is cleared
          // chat cleanup is retried at exit when its memory partition is released
          live.browserStorage?.endChat(id).catch((error) => noteIgnored("clear an archived chat's browser storage", error));
        }
      },
    });
    for (const [id, record] of chats.records) {
      permissionKeys.set(id, permissionKey(record.meta));
      codexKeys.set(id, codexKey(record.meta));
      metaHeard.seed(id, record.meta);
    }
    // a fork a chat's record names is that chat's: a window can't discard it (claude:discardFork)
    claude.setChatNames((key) => chats.names(key));
  }
  const uiPrefs = () => {
    const prefs = readState().prefs || {};
    return {
      model: null,
      effort: null,
      permission: 'default',
      serviceTier: null,
      ...prefs,
      branchPrefix: branchPrefixOf(prefs.branchPrefix, prefs.prefsVersion),
    };
  };

  return {
    STATE_FILE,
    readState,
    writeState,
    uiPrefs,
    preferHighestCli: () => preferHighestCli,
    openChats,
    /** @returns {InstanceType<typeof ChatsStore>} */
    get chats() {
      return chats;
    },
    get migration() {
      return migration;
    },
    /** @param {typeof migration} v */
    set migration(v) {
      migration = v;
    },
  };
}

module.exports = { createAppState };
