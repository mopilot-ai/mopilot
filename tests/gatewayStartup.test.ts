// App startup opens the MCP gateway (electron/app/startup.cjs, #2999 C2): once the tool Registry, the chats and MoMo are up, live.gateway is the gateway under the app's data folder, with its tools offered through live.capabilities; quitting closes it. The startup's other services are stubs here.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-fixtures.ts';

const stub = (names: string[], value: any = () => null) => ({ namedExports: Object.fromEntries(names.map((n) => [n, value])) });
mock.module('../electron/app/alwaysOnWiring.cjs', stub(['openAlwaysOn', 'openStartupWindow', 'startRemote']));
mock.module('../electron/app/routines.cjs', stub(['openRoutines']));
mock.module('../electron/app/mobileRemote.cjs', stub(['openMobileRemote']));
mock.module('../electron/capabilities/browser/userTurn.cjs', stub(['installUserTurns']));
mock.module('../electron/perf/stalls.cjs', stub(['startStallLogger']));
mock.module('../electron/platform/speechWindows.cjs', stub(['registerSpeechWindows']));
mock.module('../electron/remote/settingsWindows.cjs', stub(['registerRemoteWindows']));

const require = createRequire(import.meta.url);
const { startApp } = require('../electron/app/startup.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

/** Any service: every property is a function that does nothing (an async one where startup awaits it). */
const anything = (): any =>
  new Proxy(
    {},
    {
      get: (_t, k) => (k === 'then' ? undefined : async () => null),
    },
  );

test('startup opens the gateway once the Registry, chats and MoMo are up; quitting closes it', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-start-'));
  after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const quit = new AbortController();
  const live: any = {
    capabilities: new Registry(),
    chats: { records: new Map() },
    telemetry: { error: () => {}, flush: async () => {}, start: () => {}, track: () => {} },
    computerAccess: { open: () => {} },
    acpAdmission: { refresh: async () => {} },
    mopilot: { refreshStatus: () => {} },
  };
  let readiness!: () => Promise<any>;
  startApp({
    app: { whenReady: async () => {}, on: () => {}, getPath: () => userData, getVersion: () => '0' },
    ipcMain: { on: () => {}, handle: (_c: string, fn: () => Promise<any>) => (readiness = fn) },
    lifecycle: { quitSignal: quit.signal, onReady: () => {}, installPing: { start: () => {} } },
    browserTools: { setupGuests: () => {}, registerBrowserTools: async () => {} },
    shellEnv: anything(),
    signIns: { openAccounts: async () => {}, openMoPilot: () => {} },
    agentTools: { openTools: async () => {}, openComputerUse: () => {} },
    updates: { restartLaunch: () => ({ hash: '', window: null }), openUpdates: () => {} },
    appState: { openChats: () => {} },
    chatSessions: { openAcp: () => {}, openSessions: () => {} },
    registerIpc: () => {},
    openFlags: () => ({}),
    menus: {},
    readState: () => ({ prefs: {} }),
    buildMenu: () => {},
    createWindow: () => {},
    automations: { registerOrchestration: () => {}, registerChromePanel: () => {}, registerMomo: () => {}, start: () => {} },
    live,
    safeStorage: fakeSafe(),
    fsPromises: fs.promises,
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
  assert.ok(live.gateway, 'live.gateway is set');
  assert.deepEqual(live.gateway.view(), { state: 'ok', servers: [] });
  quit.abort();
  assert.equal(live.gateway.upstreams.running.size, 0);
});
