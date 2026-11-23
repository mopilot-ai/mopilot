// A fake Electron and fake collaborators for loading electron/main.cjs in a unit test.
// loadMain() mocks `electron`, `node:child_process` and every module main.cjs requires (except a few
// pure ones: quickChat, fsutil, keybindings, channel, downloadName, gitParse, and main's own modules under
// electron/app/ipc and electron/app, which take everything else from main as arguments), then requires main.cjs
// with a temp userData. The app's IPC handlers, app events and the options main passes to each
// collaborator are recorded so tests can drive them. Electron itself is never launched.
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hideSystemPaths } from './hermetic-system-fs.ts';
import { winbinStub } from './winbin-stub.ts';
import { shellEnvStub } from './shell-env-stub.ts';
import { computerUseFake } from './electron-main-computer-use.ts';
import { claudeFakes } from './electron-main-claude.ts';
import { mainProcesses } from './electron-main-processes.ts';
import { fixtureProfile, mainMigrations } from './electron-main-migrations.ts';
import { mainTransports } from './electron-main-transports.ts';
import { mainChatStoreModule } from './electron-main-chat-store.ts';
import { fakeSession, fakeTray } from './electron-main-shell.ts';
import { TitleBarWindow, ZoomableContents, batchOf } from './fake-window-chrome.ts';

const require = createRequire(import.meta.url);
const { fakeDebugger } = require('../helpers/browser.cjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const MAIN = path.join(ROOT, 'electron', 'main.cjs');
// main's own modules, loaded for real: the IPC handlers, the app wiring main composes, and the CLI lookup (it keeps what it saw)
const OWN = ['app/', 'harness/items/', 'platform/userTools', 'platform/toolVersion'].map((f) => path.join(ROOT, 'electron', f));
const url = (rel: string) => 'file://' + path.join(ROOT, rel);
// the real before-quit holds (pure), so quit tests drive the gate and the cleanup wait the way main does
const { holdQuit, cleanupHold, quitDeadline } = require(path.join(ROOT, 'electron', 'platform', 'exitGate.cjs'));

/** An object whose unknown properties are mock functions (returning undefined), created on first use. */
export function stub(init: Record<string, any> = {}): any {
  return new Proxy(
    { ...init },
    {
      get(t: any, k) {
        if (k in t) return t[k];
        if (typeof k === 'symbol' || k === 'then' || k === 'toJSON' || k === 'constructor') return undefined;
        return (t[k] = mock.fn());
      },
    },
  );
}
const fn = (impl?: (...a: any[]) => any) => mock.fn(impl);
const resolved = (v?: any) => mock.fn(async () => v);

export type Config = {
  platform?: string;
  env?: Record<string, string | undefined>;
  packaged?: boolean;
  singleLock?: boolean;
  /** ui-state.json, written before main loads */
  state?: any;
  /** runs after the fakes exist and before main.cjs is required */
  before?: (h: Harness) => void;
};

export type Harness = Awaited<ReturnType<typeof loadMain>>;

let active: { mocks: any[]; env: Record<string, string | undefined>; showSystem: () => void } | null = null;

/** Undo the previous load's module mocks and environment. */
export function unloadMain() {
  if (!active) return;
  for (const m of active.mocks) m.restore();
  active.showSystem();
  for (const [k, v] of Object.entries(active.env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  active = null;
  delete require.cache[MAIN];
  // main's own modules are loaded for real: drop them too, so each load sees the current mocks
  for (const k of Object.keys(require.cache)) if (OWN.some((dir) => k.startsWith(dir))) delete require.cache[k];
}

export async function loadMain(cfg: Config = {}) {
  unloadMain();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-main-'));
  const appData = path.join(tmp, 'appData');
  const userData = fixtureProfile(appData);
  fs.mkdirSync(userData, { recursive: true });
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  if (cfg.state) fs.writeFileSync(path.join(userData, 'ui-state.json'), JSON.stringify(cfg.state));
  const env: Record<string, string | undefined> = {
    HOME: home,
    VITE_DEV_SERVER_URL: undefined,
    SAGE_BOUNDS: undefined,
    MOPILOT_USER_DATA: undefined,
    SAGE_USER_DATA: undefined,
    SAGE_DEBUG_TOOLS: undefined,
    MOPILOT_SCHEDULER_TEST: undefined,
    SAGE_VISION_FAKE: undefined,
    MOPILOT_FLAGS: undefined,
    CODEX_BIN: undefined,
    MOPILOT_SITE_RISK_URL: undefined,
    ...cfg.env,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  /* ---------------- electron ---------------- */
  const windows: any[] = [];
  const ui: any = { focused: null, isReady: false, readyCb: null as null | (() => Promise<void>) };
  let wcId = 100;
  const allContents: any[] = [];
  class WebContents extends ZoomableContents {
    id = wcId++;
    sent: any[][] = [];
    destroyed = false;
    session: any = null;
    navigationHistory = { clear: fn() };
    type = 'window';
    openHandler: any = null;
    hostWebContents: any = null;
    debugger = fakeDebugger();
    constructor() {
      super();
      allContents.push(this);
    }
    send(...a: any[]) {
      this.sent.push(a);
    }
    isDestroyed() {
      return this.destroyed;
    }
    setWindowOpenHandler(f: any) {
      this.openHandler = f;
    }
    getType() {
      return this.type;
    }
    /** what was sent on one channel */
    on_(channel: string) {
      return this.sent.flatMap((s) => (s[0] === 'stream:batch' ? batchOf(s) : [s]).filter((e) => e[0] === channel).map((e) => e.slice(1)));
    }
  }
  class BrowserWindow extends TitleBarWindow {
    opts: any;
    webContents = new WebContents();
    focused = false;
    destroyed = false;
    maximized = false;
    loaded: any[] = [];
    bounds: any = null;
    constructor(opts: any) {
      super();
      this.opts = opts;
      windows.push(this);
    }
    show() {
      this.visible = true;
      this.log.push('show');
    }
    hide() {
      this.visible = false;
      this.log.push('hide');
    }
    focus() {
      this.focused = true;
      this.log.push('focus');
    }
    restore() {
      this.minimized = false;
      this.log.push('restore');
    }
    isFocused() {
      return this.focused;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return this.minimized;
    }
    isMaximized() {
      return this.maximized;
    }
    maximize() {
      this.maximized = true;
    }
    unmaximize() {
      this.maximized = false;
    }
    setBounds(b: any) {
      this.bounds = b;
    }
    loadURL(u: string) {
      this.loaded.push(['url', u]);
    }
    loadFile(f: string, o: any) {
      this.loaded.push(['file', f, o]);
    }
    close() {
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.emit('closed');
      this.webContents.emit('destroyed');
    }
    static getFocusedWindow() {
      return ui.focused;
    }
    static getAllWindows() {
      return windows.filter((w) => !w.destroyed);
    }
    static fromWebContents(wc: any) {
      return windows.find((w) => w.webContents === wc) ?? null;
    }
  }
  const handlers = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  const ipcMain = {
    handle: (ch: string, f: Function) => {
      if (handlers.has(ch)) throw new Error(`duplicate handler ${ch}`);
      handlers.set(ch, f);
    },
    on: (ch: string, f: Function) => listeners.set(ch, f),
  };
  const app: any = Object.assign(new EventEmitter(), {
    paths: { appData, userData: path.join(appData, 'Electron'), downloads: path.join(tmp, 'Downloads') } as Record<string, string>,
    getPath: (n: string) => app.paths[n],
    setPath: (n: string, v: string) => (app.paths[n] = v),
    getVersion: () => '1.2.3',
    getPreferredSystemLanguages: () => ['en-US'],
    isPackaged: !!cfg.packaged,
    setName: fn(),
    setAppUserModelId: fn(),
    requestSingleInstanceLock: () => cfg.singleLock ?? true,
    exit: fn(),
    quit: fn(),
    isReady: () => ui.isReady,
    whenReady: () => ({ then: (cb: any) => (ui.readyCb = cb) }),
    getFileIcon: fn(async (p: string) => ({ toDataURL: () => `icon:${p}` })),
    getAppPath: () => '/app',
  });
  const { session, partitions } = fakeSession(stub({ name: 'default' }));
  const { Tray, trays } = fakeTray();
  const shortcuts = new Map<string, Function>();
  const electron: any = {
    app,
    BrowserWindow,
    webContents: { getAllWebContents: () => allContents, fromId: (id: number) => allContents.find((w) => w.id === id) ?? null },
    utilityProcess: { fork: fn(() => ({ forked: true })) },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain,
    dialog: { showOpenDialog: fn(async () => ({ canceled: true, filePaths: [] })), showSaveDialog: fn(async () => ({ canceled: true })) },
    shell: { openExternal: fn(), openPath: fn(async () => ''), showItemInFolder: fn() },
    systemPreferences: { canPromptTouchID: fn(() => false), promptTouchID: fn(async () => undefined) },
    Menu: {
      buildFromTemplate: fn((template: any[]) => ({ template, popup: fn() })),
      setApplicationMenu: fn(),
    },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }),
    clipboard: { writeText: fn() },
    Notification: class {},
    protocol: { registerSchemesAsPrivileged: fn(), handle: fn() },
    net: { fetch: fn(async () => ({ ok: true, status: 200, json: async () => [] })) },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    globalShortcut: {
      register: fn((acc: string, f: Function) => (shortcuts.set(acc, f), true)),
      unregister: fn((acc: string) => shortcuts.delete(acc)),
      isRegistered: (acc: string) => shortcuts.has(acc),
      unregisterAll: fn(() => shortcuts.clear()),
    },
    session,
    Tray,
    nativeImage: { createFromPath: fn((p: string) => ({ path: p, isEmpty: () => false })), createEmpty: fn(() => ({ empty: true })) },
    powerMonitor: new EventEmitter(),
  };
  /* ---------------- child processes ---------------- */
  const processes = mainProcesses();
  const { cp } = processes;

  /* ---------------- collaborators ---------------- */
  const inst: Record<string, any[]> = {};
  const cls = (name: string, init: (...a: any[]) => Record<string, any> = () => ({})) =>
    function (this: any, ...args: any[]) {
      const s = stub({ opts: args[0], args, ...init(...args) });
      (inst[name] ??= []).push(s);
      return s;
    } as any;
  const findTranscript = fn(async (id: string) => `/transcripts/${id}.jsonl`);
  const { claude, mods: claudeMods } = claudeFakes({ fn, resolved, cls, findTranscript });
  const mods: Record<string, any> = {
    'shared/killSwitch.cjs': { killedReason: fn(() => null), startHold: fn((off: any) => off) },
    'electron/identity/codexAccounts.cjs': {
      Accounts: cls('Accounts', () => ({
        providerInput: fn(() => 'provider-input'),
        startRelay: resolved({ openai_base_url: 'http://relay' }),
        view: fn(() => ({ accounts: [] })),
        apply: resolved('applied'),
        setMoPilotKey: resolved(),
        chatgptHeaders: resolved(null),
      })),
    },
    // host.cjs (the agent's browser tabs) checks a page with assertCdpTarget before it joins a chat's tabs
    'electron/capabilities/browser/cdp.cjs': { PanelBrowser: cls('PanelBrowser'), PARTITION: 'persist:browser', assertCdpTarget: fn() },
    // pane tabs as main-owned views (their own tests: browserViews.test.ts)
    'electron/capabilities/browser/views.cjs': {
      PaneViews: cls('PaneViews', () => ({
        create: fn(() => ({ wc: { id: 77, session: 'ses' }, keep: false })),
        adopt: fn((wc: any) => ({ wc, keep: false })),
        close: fn(() => false),
        entryOf: fn(() => null),
        windowOf: fn(() => null),
      })),
      registerViewIpc: fn(),
      isViewTab: fn(() => false),
    },
    // the browser memory guard's worker (its own tests: browserMemoryGuard.test.ts)
    'electron/capabilities/browser/memoryGuard.cjs': {
      MemoryGuard: cls('MemoryGuard', () => ({ start: fn(), stop: fn() })),
      MEMORY_MESSAGE: 'stopped for memory',
    },
    'electron/capabilities/browser/chromeMigration.cjs': { usedClaudeInChrome: fn(() => true), installedExtensionVersion: fn(() => '1.0') },
    // dev-server previews and the $BROWSER shim (their own tests: devPreview*.test.ts, browserShim.test.ts)
    'electron/capabilities/browser/devPreview.cjs': {
      DevPreviews: cls('DevPreviews'),
      registerPreviewTools: fn(),
      paneOpener: fn(() => fn(async () => ({ id: 'tab-1' }))),
    },
    'electron/capabilities/browser/browserShim.cjs': {
      BrowserShim: cls('BrowserShim', () => ({
        listen: resolved(),
        env: fn((chatId: any, env?: any) => ({ BROWSER: `shim:${chatId}`, ...env })),
      })),
    },
    'electron/capabilities/browser/codexBrowserUse.cjs': { CodexBrowserUse: cls('CodexBrowserUse') },
    'electron/capabilities/browser/codexSiteBlocks.cjs': { CodexSiteBlocks: cls('CodexSiteBlocks') },
    'electron/capabilities/browser/chromeToken.cjs': { ChromeTokens: cls('ChromeTokens') },
    'electron/capabilities/browser/control.cjs': {
      BrowserControl: cls('BrowserControl', () => ({ active: 'builtin', configure: resolved() })),
      schemaCache: fn((f: string) => ({ cache: f })),
    },
    'electron/capabilities/browser/extension.cjs': {
      ChromeChannel: cls('ChromeChannel', () => ({ releasing: fn(() => []) })),
      spawnSpec: fn((o: any) => ({ spec: o })),
      EXTENSION_URL: 'https://ext.example',
    },
    'electron/capabilities/browser/origins.cjs': {
      OriginGrants: cls('OriginGrants', () => ({ list: fn(() => ['site']) })),
      // the real address helper: modules main loads for real (the key button's IPC) read origins with it
      originOf: require(path.join(ROOT, 'electron', 'capabilities', 'browser', 'origins.cjs')).originOf,
    },
    // web permissions in the browser partitions (their own tests: browserWebPermissions.test.ts)
    'electron/capabilities/browser/webPermissions.cjs': {
      WebPermissions: cls('WebPermissions'),
      savedWebPermissions: fn((file: string) => ({ list: () => [file], forget: (origin: string) => [file, origin] })),
      dialogAsk: fn(() => fn(async (req: any) => ({ native: req }))),
    },
    'electron/capabilities/channels/codexConfig.cjs': { CodexToolInjection: cls('CodexToolInjection') },
    'electron/capabilities/channels/sessionMcp.cjs': { SessionMcp: cls('SessionMcp') },
    'electron/capabilities/computerUse.cjs': computerUseFake(inst, { stub, fn, resolved }),
    // the shared native-control status (its own tests: nativeAvailability.test.ts); Claude Code's Chrome is ready
    'electron/capabilities/nativeAvailability.cjs': {
      NativeAvailability: cls('NativeAvailability', () => ({ claudeChromeReady: fn(() => true), noteSkyProblem: fn() })),
      probeNativeAvailability: fn((o: any) => ({ probed: o })),
    },
    'electron/capabilities/contract/registry.cjs': {
      Registry: cls('Registry', () => ({
        list: fn(() => []),
        setTurnThread: fn(),
        turns: { retire: fn(), retireTurn: fn(), onRetire: fn(() => () => {}), ridden: fn(() => true) },
      })),
      OperationLog: cls('OperationLog'),
    },
    'electron/capabilities/contract/serverRequests.cjs': {
      codexServerRequests: fn((o: any) => ({ kind: 'serverRequests', o })),
      rejectNativeCuaElicitation: fn((o: any) => ({ kind: 'cua', o })),
    },
    'electron/capabilities/contract/session.cjs': { ToolSessions: cls('ToolSessions') },
    ...mainTransports(tmp, { cls, fn, resolved }),
    'electron/capabilities/tools/debug.cjs': { echo: { name: 'echo' } },
    'electron/capabilities/vision/backend.cjs': {
      anthropicVision: fn((o: any) => (req: any) => Promise.resolve({ o, req })),
      providerVision: fn((p: any, auth: any) => ({ provider: p, auth })),
      MOPILOT_VISION_MODEL: 'vision-model',
    },
    'electron/capabilities/vision/decide.cjs': { pickBackend: fn((o: any) => ({ picked: o })), MOPILOT_VENDOR: 'MoPilot' },
    'electron/capabilities/vision/index.cjs': { gatedBackend: fn((on: any, pick: any) => ({ on, pick })) },
    ...claudeMods,
    'electron/support/diagnostics.cjs': { buildDiagnostics: fn((o: any) => ({ diagnostics: o })) },
    'electron/platform/flags.cjs': {
      initFlags: fn((o: any) => ({ flags: o })),
      registerFlags: fn(),
      refreshFlags: resolved(false),
      // pane tabs as main-owned views have their own wiring tests; the rest see the <webview> path
      // as the build ships them: the pane's views, the Chrome relay and MoPilot's Chrome extension (B2, also its
      // defaults, which would serve a real channel), the performance probe, Mobile Remote's relay socket and main's ACP
      // translation are off unless a test turns them on
      isEnabled: fn(
        (k: string) =>
          k !== 'shared.browser.viewTabs' &&
          !k.startsWith('shared.browser.chrome') &&
          !k.startsWith('shared.session.') &&
          !['codex.browser.chromeExtension', 'shared.perf.probe', 'remote.enabled'].includes(k),
      ),
      parseOverride: fn((s: any) => ({ parsed: s })),
    },
    'electron/harness/acp.cjs': {
      AcpHost: cls('AcpHost', () => ({ history: fn(() => []), authenticate: resolved(), retireChat: fn(() => 0), chats: new Map() })),
      register: fn(),
    },
    'electron/harness/acpTurns.cjs': { AcpTurns: cls('AcpTurns', () => ({ sessions: new Map() })) },
    'electron/harness/admission.cjs': {
      Admission: cls('Admission', () => ({
        list: fn(() => []),
        refresh: resolved('refreshed'),
        // the entry from the stub's list (a test replaces list)
        current: fn(async function (this: any, id: string) {
          return this.list().find((h: any) => h.id === id) ?? null;
        }),
      })),
    },
    'electron/harness/codex.cjs': {
      AppServer: cls('AppServer', () => ({
        intercepts: {
          list: [] as any[],
          add(f: any) {
            this.list.push(f);
          },
        },
        status: 'idle',
        proc: null,
      })),
      CodexAdapter: cls('CodexAdapter', () => ({ init: null, annotateGoal: fn((_c: string, g: any) => g), ensureResumed: resolved() })),
      permissionParams: fn((p: string) => ({ approvalPolicy: p })),
    },
    'electron/harness/detect.cjs': {
      resolveBasic: fn((id: string, o: any) => ({ id, o })),
      createHighestBasic: fn(() => ({ resolveBin: fn(() => null), discoverBin: fn() })),
    },
    'electron/harness/quirks/index.cjs': {
      quirks: fn((id: string) => (id === 'gemini' ? { bins: ['gemini'] } : null)),
      ids: fn(() => ['gemini']),
      describe: fn((id: string) => (id === 'gemini' ? { plan: 'gemini-plan', label: 'Gemini' } : null)),
    },
    'electron/identity/contract/codexProvider.cjs': {
      CodexProviders: cls('CodexProviders', () => ({ sync: resolved() })),
      authCommandPath: fn(() => '/auth-cmd'),
    },
    'electron/identity/drivers/acp.cjs': { AcpDriver: cls('AcpDriver') },
    'electron/identity/drivers/claude.cjs': { ClaudeDriver: cls('ClaudeDriver') },
    'electron/identity/drivers/codex.cjs': { CodexDriver: cls('CodexDriver') },
    'electron/identity/contract/registry.cjs': { Registry: cls('IdentityRegistry') },
    'electron/platform/install.cjs': {
      installId: fn(() => 'install-1'),
      API_BASE: 'https://api.example',
      reportsToService: fn(() => false),
    },
    ...mainMigrations(fn),
    'electron/identity/mopilot.cjs': {
      MoPilotAccount: cls('MoPilotAccount', () => ({
        status: fn(() => ({ user: null })),
        gatewayKey: fn(() => 'gw-key'),
        modelCaps: resolved({ m: 1 }),
        accessToken: resolved('tok'),
        setConsent: resolved(),
      })),
    },
    'electron/support/notices.cjs': { openNotices: fn((o: any) => ({ notices: o })) },
    'electron/platform/automationRun.cjs': { AutomationRunner: cls('AutomationRunner') },
    'electron/platform/automationStore.cjs': {
      AutomationStore: cls('AutomationStore', () => ({
        list: resolved({ tasks: ['a'], errors: [] }),
        get: fn(async (id: string) => ({ id })),
        save: fn(async (t: any) => ({ ...t, id: t.id || 'saved' })),
        rememberChat: resolved(true),
        migrate: resolved([]),
        sync: resolved(),
      })),
    },
    'electron/platform/runLedger.cjs': { RunLedger: cls('RunLedger', () => ({ list: resolved([{ scheduledFor: 2 }]) })) },
    'electron/platform/nativeSchedulers.cjs': {
      codexApp: fn((o: any) => stub({ opts: o, runs: fn(() => [{ scheduledFor: 3 }, { scheduledFor: 1 }]) })),
      claudeDesktop: fn(() => stub({ desktop: true })),
    },
    'electron/capabilities/tools/scheduledTasks.cjs': { registerScheduledTaskTools: fn() },
    'electron/platform/chats.cjs': mainChatStoreModule(fn, cls),
    'electron/platform/codexImport.cjs': { listCodexProjects: resolved(['p']) },
    'electron/platform/disclaim.cjs': { configure: fn(), disclaimPath: fn(() => '/disclaim') },
    'electron/platform/env.cjs': shellEnvStub(fn),
    'electron/platform/exitGate.cjs': {
      createExitGate: fn((o: any) => {
        const s = stub({ opts: o, passed: false, request: resolved(true), collect: resolved([]) });
        (inst.exitGate ??= []).push(s);
        return s;
      }),
      ...{ holdQuit, cleanupHold, quitDeadline },
      isEmpty: fn((x: any) => !x.length),
    },
    'electron/platform/fs.cjs': { register: fn() },
    'electron/platform/git.cjs': { register: fn(), worktreeAdd: fn(), runScript: fn() },
    'electron/platform/notify.cjs': { registerNotify: fn((_ipc: any, o: any) => stub({ opts: o })) },
    'electron/platform/projects.cjs': { ProjectsStore: cls('ProjectsStore'), registerProjects: fn() },
    'electron/platform/pty.cjs': { register: fn(), killAll: fn() },
    'electron/platform/scheduler.cjs': {
      Scheduler: cls('Scheduler', () => ({ skew: 0, now: fn(() => 1000) })),
      nextRun: fn((rule: string, after: Date) => ({ rule, after })),
      rules: { describe: fn((rule: string) => `described ${rule}`) },
    },
    'electron/platform/search.cjs': { register: fn() },
    'electron/platform/voice.cjs': { createDictation: fn((o: any) => stub({ opts: o })) },
    'electron/session/caps.cjs': { CapsService: cls('CapsService', () => ({ get: resolved({ caps: true }) })) },
    'electron/session/controller.cjs': { ChatController: cls('ChatController') },
    'electron/session/goalHeld.cjs': {
      heldOf: fn((g: any) => ({ held: g })),
      restoreGoal: fn((h: any, id: string) => ({ restored: h, id })),
    },
    'electron/session/contract/reconcile.cjs': {
      ExternalWrites: cls('ExternalWrites'),
      claudeTailRunning: fn(() => true),
      tailLines: fn((f: string) => [f]),
    },
    'electron/session/state.cjs': { SessionStore: cls('SessionStore') },
    'electron/session/switch.cjs': { SwitchRunner: cls('SwitchRunner') },
    // the controller plan record (its own tests: controllerPlan*.test.ts); main's wiring passes planInputs its live services
    'electron/session/controllerPlan.cjs': { ControllerPlans: cls('ControllerPlans'), planInputs: fn((o: any) => ({ planInputs: o })) },
    'electron/support/telemetry.cjs': {
      Telemetry: cls('Telemetry'),
      mergeConsent: fn(() => ({ write: false, put: false })),
      harnessVersions: fn((o: any) => o),
      REPORT_MARKER: 'report-marker',
    },
    'electron/updates/updater.cjs': { Updater: cls('Updater', () => ({ state: { s: 1 }, channel: 'stable' })) },
    'electron/platform/winbin.cjs': winbinStub(fn),
  };

  const h = {
    tmp,
    home,
    appData,
    userData,
    electron,
    app,
    ui,
    windows,
    trays,
    shortcuts,
    partitions,
    handlers,
    listeners,
    cp,
    inst,
    mods,
    claude,
    cls,
    main: null as any,
    processHandlers: {} as Record<string, Function>,
    /** the first instance a class made */
    one: (name: string) => {
      const list = inst[name];
      if (!list?.length) throw new Error(`no ${name}`);
      return list[0];
    },
    mod: (rel: string) => mods[/^(electron|shared)\//.test(rel) ? rel : `electron/${rel}`],
    /** paths that exist for main besides the temp dirs (system install folders are hidden) */
    exists: new Set<string>(),
    wc: (opts: any = {}) => Object.assign(new WebContents(), opts),
    event: (sender?: any) => ({
      sender: sender ?? h.windows.find((w) => !w.destroyed)?.webContents ?? new WebContents(),
      preventDefault: fn(),
    }),
    /** call an ipcMain.handle handler as a window would */
    invoke: (ch: string, ...args: any[]) => h.invokeFrom(undefined, ch, ...args),
    invokeFrom: (sender: any, ch: string, ...args: any[]) => {
      const f = handlers.get(ch);
      if (!f) throw new Error(`no handler ${ch}`);
      return f(h.event(sender), ...args);
    },
    emitIpc: (ch: string, sender: any, ...args: any[]) => {
      const f = listeners.get(ch);
      if (!f) throw new Error(`no listener ${ch}`);
      return f({ sender }, ...args);
    },
    /** run app.whenReady()'s callback */
    ready: async () => {
      ui.isReady = true;
      await withPlatform(cfg.platform ?? process.platform, () => ui.readyCb!());
    },
    writeState: (s: any) => fs.writeFileSync(path.join(userData, 'ui-state.json'), JSON.stringify(s)),
    WebContents,
    BrowserWindow,
  };
  cfg.before?.(h);

  const mocks = [mock.module('electron', { exports: electron }), ...processes.mocks()];
  for (const [rel, exports] of Object.entries(mods)) mocks.push(mock.module(url(rel), { exports }));
  // system install folders main probes (Codex, editors): hidden so the machine running the tests doesn't matter
  active = { mocks, env: saved, showSystem: hideSystemPaths(h.exists) };

  const before = { u: process.listeners('uncaughtException'), r: process.listeners('unhandledRejection') };
  const platform = process.platform;
  if (cfg.platform) Object.defineProperty(process, 'platform', { value: cfg.platform, configurable: true });
  try {
    delete require.cache[MAIN];
    h.main = require(MAIN);
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    for (const [ev, prev] of [
      ['uncaughtException', before.u],
      ['unhandledRejection', before.r],
    ] as const)
      for (const l of process.listeners(ev as any))
        if (!prev.includes(l)) process.removeListener(ev as any, l), (h.processHandlers[ev] = l);
  }
  return h;
}

/** Let pending promise callbacks run. */
export const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Run with process.platform set to another value. */
export async function withPlatform<T>(p: string, f: () => T | Promise<T>): Promise<T> {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
  try {
    return await f();
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
}
