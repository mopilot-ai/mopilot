// What app startup hands the MCP gateway for its rules (electron/app/startup.cjs, #2999 C3): the user's settings as they are when read (a Codex chat's default permission) and each chat's folder from its harness (session/chatProject.cjs), both read at the moment they are asked for. The gateway's own wiring is a stand-in here; tests/gatewayStartup.test.ts runs the real one.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const stub = (names: string[], value: any = () => null) => ({ namedExports: Object.fromEntries(names.map((n) => [n, value])) });
let opened: any = null;
mock.module('../electron/app/gatewayWiring.cjs', { namedExports: { openGateway: (o: any) => ((opened = o), { view: () => null }) } });
mock.module('../electron/app/alwaysOnWiring.cjs', stub(['openAlwaysOn', 'openStartupWindow', 'startRemote']));
mock.module('../electron/app/routines.cjs', stub(['openRoutines']));
mock.module('../electron/app/mobileRemote.cjs', stub(['openMobileRemote']));
mock.module('../electron/capabilities/browser/userTurn.cjs', stub(['installUserTurns']));
mock.module('../electron/perf/stalls.cjs', stub(['startStallLogger']));
mock.module('../electron/platform/speechWindows.cjs', stub(['registerSpeechWindows']));
mock.module('../electron/remote/settingsWindows.cjs', stub(['registerRemoteWindows']));

const require = createRequire(import.meta.url);
const { startApp } = require('../electron/app/startup.cjs');

test('startup gives the gateway the settings as read now and each chat’s folder from its harness', async () => {
  let prefs: any = { permission: 'default' };
  const folders: string[] = [];
  const any = (): any => new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : async () => null) });
  let readiness!: () => Promise<any>;
  startApp({
    app: { whenReady: async () => {}, on: () => {}, getPath: () => '/tmp/none', getVersion: () => '0' },
    ipcMain: { on: () => {}, handle: (_c: string, fn: () => Promise<any>) => (readiness = fn) },
    lifecycle: { quitSignal: new AbortController().signal, onReady: () => {}, installPing: { start: () => {} } },
    browserTools: { setupGuests: () => {}, registerBrowserTools: async () => {} },
    shellEnv: any(),
    signIns: { openAccounts: async () => {}, openMoPilot: () => {} },
    agentTools: { openTools: async () => {}, openComputerUse: () => {} },
    updates: { restartLaunch: () => ({ hash: '', window: null }), openUpdates: () => {} },
    appState: { openChats: () => {} },
    chatSessions: { openAcp: () => {}, openSessions: () => {}, chatProject: async (id: string) => (folders.push(id), `/work/${id}`) },
    registerIpc: () => {},
    openFlags: () => ({}),
    menus: {},
    readState: () => ({ prefs }),
    buildMenu: () => {},
    createWindow: () => {},
    automations: { registerOrchestration: () => {}, registerChromePanel: () => {}, registerMomo: () => {}, start: () => {} },
    live: {
      telemetry: { error: () => {}, flush: async () => {}, start: () => {}, track: () => {} },
      computerAccess: { open: () => {} },
      acpAdmission: { refresh: async () => {} },
      mopilot: { refreshStatus: () => {} },
    },
    safeStorage: null,
    fsPromises: {},
    broadcastAll: () => {},
    chromeState: () => ({}),
    reportMigrationOnce: () => {},
    setMiniShortcut: () => {},
    setVoiceHotkey: () => {},
    setTray: () => {},
    setupDownloads: () => {},
    showMainWindow: async () => {},
  });
  assert.deepEqual(await readiness(), { value: null });
  assert.deepEqual(opened.prefs(), { permission: 'default' });
  prefs = { permission: 'full-access' };
  assert.deepEqual(opened.prefs(), { permission: 'full-access' }, 'read when asked, not at startup');
  prefs = undefined;
  assert.deepEqual(opened.prefs(), {});
  assert.equal(await opened.projectOf('chat-9'), '/work/chat-9');
  assert.deepEqual(folders, ['chat-9']);
});
