// Shared fixture for the Settings, Accounts and related component tests: stubs the store, the
// native bridge and heavy child components, and offers small DOM helpers. Call setup() once per
// test file, before anything imports the units under test.
import { remoteControlStubs } from './remote-control-stubs.ts';
import { resolvedEnvironment } from './environment.ts';
import { registerHooks } from 'node:module';
import { window } from './dom.ts';
import { defaultHarnessExports } from './default-harness-fakes.ts';
import { storeSliceStubs } from './stubs.ts';
import { installNativeStub } from './ports/native.ts';

export const calls: any[][] = [];
/** Results for native bridge calls by "namespace.method": a value, or a function of the arguments. */
export const responses: Record<string, any> = {};
/** Knobs the stubs read on each render. */
export const ctl: any = {};

export function defaultPrefs(): any {
  return {
    defaultHarness: 'codex',
    permission: 'default',
    projectlessFolder: null,
    showInMenuBar: false,
    confirmClose: 'shortcut',
    fullViewDefault: false,
    changesLastTurnOnly: false,
    bottomPanelControl: true,
    simulatorIos: true,
    simulatorAndroid: true,
    defaultTerminal: 'bottom',
    sendWith: 'enter',
    followUp: 'queue',
    notifyKinds: undefined,
    notifyOnComplete: 'unfocused',
    showReasoning: true,
    theme: 'system',
    themePreset: null,
    accent: null,
    bgOverride: null,
    fgOverride: null,
    fontFamily: null,
    fontSize: 14,
    codeFontSize: 12,
    wrapCode: false,
    keybindings: {},
    sshHosts: undefined,
    branchPrefix: 'codex/',
    worktreeRoot: null,
    autoDeleteWorktrees: false,
    autoDeleteLimit: 15,
    autoUpdate: undefined,
    updateChannel: 'stable',
    dictationEngine: null,
    micDeviceId: null,
    dictationLanguage: 'auto',
    voice: 'cove',
    voiceHotkey: null,
    miniShortcut: false,
    localUrlDestination: 'in-app',
    browserFullUrl: false,
    downloadsDir: null,
    askWhereToSave: false,
    browserChannel: 'builtin',
    chromeProfileDir: '',
    openDestination: 'finder',
    visibleEfforts: undefined,
  };
}
export function defaultState(): any {
  return {
    prefs: defaultPrefs(),
    home: '/Users/me',
    route: { name: 'settings', section: 'general' },
    archived: [],
    savedProjects: [],
    userAgent: 'codex/1.2.3 (mac)',
    codexHome: '/Users/me/.codex',
    codexBin: null,
    accounts: { accounts: [], active: null, pool: 'single', relay: false, login: null },
    account: null,
    claudeAccounts: { login: null },
    claudeUsage: {},
    claudeChats: {},
    codexRestart: null,
    basicHarnesses: [],
  };
}
export function resetCtl() {
  for (const k of Object.keys(ctl)) delete ctl[k];
  for (const k of Object.keys(responses)) delete responses[k];
  // Settings → General's scheduled tasks: no native apps installed and no tasks, unless a test says otherwise
  Object.assign(responses, {
    'prefs.recording': () => Promise.resolve(true),
    'automation.onChanged': () => () => {},
    // the shared native-control status (src/session/nativeAvailability.ts) that Browser's Preferred browser reads
    'availability.onChanged': () => () => {},
    'browser.onChannelChanged': () => () => {},
    // Connections' Keep this Mac reachable group subscribes to main's state
    'alwaysOn.onChanged': () => () => {},
    // Settings → Connections' optional connectors and Quick Actions: none offered unless a test says otherwise
    'plugins.builtin.list': [],
    'app.quickActions.status': { state: 'unavailable', installed: 0, total: 3 },
    'automation.list': { tasks: [], errors: [] },
    'automation.apps': {
      scheduler: true,
      codexApp: { installed: false, running: false },
      claudeDesktop: { installed: false, running: false },
    },
  });
  Object.assign(ctl, {
    dark: false,
    // the harness answers true for a flag nobody scripted; Superagent's page is listed only when a test turns it on
    flags: { superagent: false } as Record<string, boolean>,
    update: { status: 'idle', version: '1.0.0' },
    mopilotUser: null,
    dictationEngine: 'chatgpt',
    status: {} as Record<string, any>,
    harnessAccounts: {} as Record<string, any>,
    parts: { codex: {}, claude: {} },
    loginTerm: null,
    confirm: true,
    archivedLoad: () => Promise.resolve([]),
    env: null as any,
    resolved: null as any,
    convertEnv: async () => {},
    writeEnv: async () => {},
    subscriptions: (a: any[]) => a,
  });
  calls.length = 0;
}
resetCtl();

const record =
  (name: string, impl?: (...a: any[]) => any) =>
  (...args: any[]) => {
    calls.push([name, ...args]);
    return impl ? impl(...args) : undefined;
  };
const respond = (key: string, args: any[]) => {
  const r = responses[key];
  // a subscription no test scripted answers as the bridge's does: with its unsubscribe
  if (r === undefined && /\.on[A-Z]\w*$/.test(key)) return () => undefined;
  return typeof r === 'function' ? r(...args) : Promise.resolve(r);
};
/** native.x.y(...) records ["x.y", ...args] and returns responses["x.y"]; it names no platform (src/lib/platform's default). */
export const native: any = new Proxy(
  {},
  {
    get: (_, ns: string) =>
      ns === 'platform'
        ? undefined
        : new Proxy(
            {},
            {
              get: (_2, fn: string) =>
                // the bridge's nested groups (plugins.builtin, app.quickActions) answer as "ns.group.method"
                fn === 'builtin' || fn === 'quickActions'
                  ? new Proxy(
                      {},
                      {
                        get:
                          (_3, sub: string) =>
                          (...args: any[]) => {
                            calls.push([`${ns}.${fn}.${sub}`, ...args]);
                            return respond(`${ns}.${fn}.${sub}`, args);
                          },
                      },
                    )
                  : (...args: any[]) => {
                      if (ns === 'speech' && fn === 'options') {
                        if (responses['speech.options']) return respond('speech.options', args);
                        if (ctl.dictationEngine instanceof Error) return Promise.reject(ctl.dictationEngine);
                        return Promise.resolve({
                          engine: ctl.dictationEngine,
                          chain: ctl.dictationEngine ? [ctl.dictationEngine] : [],
                          choices: [],
                        });
                      }
                      calls.push([`${ns}.${fn}`, ...args]);
                      return respond(`${ns}.${fn}`, args);
                    },
            },
          ),
  },
);

export let useStore: any;
export const names = (prefix: string) => calls.filter((c) => c[0].startsWith(prefix));

export async function setup(platform: { isMac?: boolean; isWin?: boolean } = {}) {
  const React = await import('react');
  const h = React.createElement;
  const { create } = await import('zustand');
  useStore = create<any>(() => defaultState());
  const setPrefs = (p: any) => {
    calls.push(['setPrefs', p]);
    useStore.setState({ prefs: { ...useStore.getState().prefs, ...p } });
  };
  const stub = (label: string) => (props: any) => h('div', { 'data-stub': label, 'data-props': JSON.stringify(props ?? {}) });
  const url = (p: string) => new URL(`../../src/${p}`, import.meta.url).href;
  // Modules are swapped at resolution time (node's mock.module cannot stand in for a .tsx file).
  const mocks: Record<string, Record<string, any>> = ((globalThis as any).__settingsMocks = {});
  const m = (p: string, namedExports: Record<string, any> = {}) => {
    mocks[url(p)] = namedExports;
  };
  registerHooks({
    resolve(s, c, next) {
      const r = next(s, c);
      const exp = mocks[r.url];
      if (!exp) return r;
      const names = Object.keys(exp);
      const src = `const m = globalThis.__settingsMocks[${JSON.stringify(r.url)}];${names.length ? `export const ${names.map((n) => `${n} = m.${n}`).join(', ')};` : ''}`;
      return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
    },
  });

  // the store's names, each put on the slice that owns it below (a component imports the slice)
  const storeStubs: Record<string, any> = {
    useStore,
    getState: () => useStore.getState(),
    setState: (p: any) => {
      calls.push(['setState', p]);
      useStore.setState(p);
    },
    navigate: record('navigate'),
    leaveSettings: record('leaveSettings'),
    setPrefs,
    ...defaultHarnessExports(() => useStore.getState(), setPrefs),
    createProject: record('createProject'),
    forgetHostMachine: record('forgetHostMachine'),
    ...{ pickNewChatHost: record('pickNewChatHost'), setNewChatHostFolder: record('setNewChatHostFolder') },
    openPaneTab: record('openPaneTab'),
    loadArchived: record('loadArchived', () => ctl.archivedLoad()),
    unarchiveThread: record('unarchiveThread', async () => {
      if (ctl.unarchiveError) throw ctl.unarchiveError;
    }),
    deleteThread: record('deleteThread', async () => {
      if (ctl.deleteError) throw ctl.deleteError;
    }),
    threadTitle: (t: any) => t.title ?? 'Untitled',
    toast: record('toast'),
    toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
    projectForThread: (t: any, projects: any[]) => projects.find((p) => t.cwd && t.cwd.startsWith(p.roots[0].path)) ?? null,
    switchAccount: record('switchAccount'),
    addAccount: record('addAccount'),
    cancelAccountLogin: record('cancelAccountLogin'),
    removeAccount: record('removeAccount', async () => {
      if (ctl.removeError) throw ctl.removeError;
    }),
    ensureCodex: record('ensureCodex'),
    refreshAccountsUsage: record('refreshAccountsUsage', async () => {
      if (ctl.refreshError) throw ctl.refreshError;
    }),
    setAutoSwitch: record('setAutoSwitch'),
    setAccountPool: record('setAccountPool'),
    login: record('login', async () => {
      if (ctl.loginError) throw ctl.loginError;
    }),
    connect: record('connect', async () => {}),
    // which harnesses a chat's history is read from (store/chatRetry.ts): ctl.readFamilies, else Codex
    readFamilies: () => new Set(ctl.readFamilies ?? ['codex']),
    // the store's restartCodex: the banner goes, main restarts Codex's app-server, then the window connects
    restartCodex: async () => {
      calls.push(['setState', { codexRestart: null }]);
      useStore.setState({ codexRestart: null });
      await native.codex.restart();
      calls.push(['connect']);
    },
  };
  installNativeStub(native);
  m('lib/hostChats.ts', { hostOfChatNow: () => '' }), m('store/hostAgent.ts', { hostAgentOf: () => '' }); // every chat here is this Mac's
  m('lib/platform.ts', {
    platform: platform.isWin ? 'win32' : 'darwin',
    isMac: platform.isMac ?? true,
    isWin: platform.isWin ?? false,
    shortcutLabel: (k: string) => `[${k}]`,
    modKey: (e: { metaKey: boolean }) => e.metaKey,
    revealLabel: () => (platform.isWin ? 'Show in Explorer' : 'Show in Finder'),
  });
  m('components/markdown/Markdown.tsx', {
    useResolvedDark: () => ctl.dark,
    // Settings → About renders a ready update's What's new as Markdown
    Markdown: ({ text }: { text: string }) => h('div', { 'data-markdown': '' }, text),
  });
  m('components/pages/HarnessSettings.tsx', { HarnessSettings: stub('HarnessSettings') });
  m('components/harness/Section.tsx', {
    HarnessSection: stub('HarnessSection'),
    // a harness page gives its own title
    hasOwnHeader: (section: string) => section === 'codex' || section === 'claude',
  });
  m('components/pages/Login.tsx');
  m('components/pages/settings/AccountsBilling.tsx', { AccountsBilling: stub('AccountsBilling') });
  m('components/harnessPicker/HarnessPicker.tsx', {
    HarnessIcon: (p: any) => h('i', { 'data-icon': p.h, role: 'img', 'aria-label': p.h === 'codex' ? 'Codex' : 'Claude Code' }),
    BasicHarnessIcon: (p: any) => h('i', { 'data-icon': `acp:${p.id}` }),
    signInHarness: record('signInHarness'),
  });
  m('session/harness/acp.ts', {
    useFreshBasics: () => {},
    detectBasicHarnesses: async () => (await import('../../src/session/harness/acpDiscovery')).detectBasicHarnesses(),
  });
  m('session/harness/billing.ts');
  m('session/harness/claude.ts', {
    addClaudeAccount: record('addClaudeAccount'),
    cancelClaudeLogin: record('cancelClaudeLogin'),
    endClaudeLoginTerm: record('endClaudeLoginTerm'),
    useClaudeLoginTerm: () => ctl.loginTerm,
    recheckClaude: record('recheckClaude'),
    refreshClaudeAccounts: record('refreshClaudeAccounts', async () => {
      if (ctl.claudeRefreshError) throw ctl.claudeRefreshError;
    }),
    refreshClaudeUsage: record('refreshClaudeUsage', async () => {
      if (ctl.claudeUsageError) throw ctl.claudeUsageError;
    }),
    reloginClaudeAccount: record('reloginClaudeAccount'),
    removeClaudeAccount: record('removeClaudeAccount', async () => {}),
    setClaudeAutoSwitch: record('setClaudeAutoSwitch'),
    switchClaudeAccount: record('switchClaudeAccount'),
  });
  // the real account shapes over the store: Codex's view is the account manager's pool, as in harness/select.ts
  const { codexAccounts } = await import('../../src/harness/accounts.ts');
  const storeMock = () => storeStubs;
  const claudeMock = () => mocks[url('session/harness/claude.ts')];
  m('session/harness/select.ts', {
    useHarnessStatus: (hn: string) => ctl.status[hn] ?? { state: 'ready' },
    useHarnessAccounts: (hn: string) => {
      const s = useStore((st: any) => st);
      return (
        ctl.harnessAccounts[hn] ??
        (hn === 'codex'
          ? codexAccounts({ accounts: s.accounts, account: s.account, rateLimits: s.rateLimits, requiresAuth: s.requiresAuth })
          : { accounts: [], active: null, multi: false })
      );
    },
    addHarnessAccount: record('addHarnessAccount'),
    // the routing of harness/select.ts, onto the store's and Claude Code's stand-ins
    chooseAccount: (a: any) => {
      calls.push(['chooseAccount', a]);
      const s = useStore.getState();
      if (a.harness === 'claude') {
        if (a.status !== 'ok') return claudeMock().reloginClaudeAccount(a.id);
        if (a.id !== s.claudeAccounts?.active) return claudeMock().switchClaudeAccount(a.id);
        return;
      }
      if (a.status !== 'ok') return s.accounts.accounts.length ? storeMock().addAccount(a.id) : storeMock().login();
      if (a.id !== s.accounts.active) return storeMock().switchAccount(a.id);
    },
    verifyAccount: (a: any) => claudeMock().reloginClaudeAccount(a.id),
    removeHarnessAccount: (a: any) => (a.harness === 'claude' ? claudeMock().removeClaudeAccount(a.id) : storeMock().removeAccount(a.id)),
    codexSubscriptions: (a: any[]) => ctl.subscriptions(a),
  });
  m('components/harness/parts.tsx', {
    PARTS: new Proxy(
      {},
      {
        get: (_, k: string) => ctl.parts[k],
        ownKeys: () => Object.keys(ctl.parts),
        getOwnPropertyDescriptor: (_, k: string) => ({ enumerable: true, configurable: true, value: ctl.parts[k] }),
      },
    ),
  });
  m('components/panels/TerminalPanel.tsx', { TermView: stub('TermView') });
  m('harness/adapters/codex.ts');
  m('session/updates.ts', { useUpdateState: () => ctl.update });
  m('session/voice.ts', {
    currentDictationEngine: async () => {
      if (ctl.dictationEngine instanceof Error) throw ctl.dictationEngine;
      return ctl.dictationEngine;
    },
  });
  m('lib/mopilot.ts', { useMoPilot: () => ({ user: ctl.mopilotUser }) });
  m('components/pages/MoPilotSettings.tsx', { PrivacySettings: stub('PrivacySettings') });
  m('components/pages/settings/RemoteControl.tsx', remoteControlStubs(stub));
  m('components/pages/settings/OtherHarnesses.tsx', { OtherHarnesses: stub('OtherHarnesses') });
  m('components/pages/settings/ComputerUse.tsx', { ComputerUseSettings: stub('ComputerUseSettings') });
  m('components/pages/settings/ComputerHistory.tsx', { ComputerHistorySettings: stub('ComputerHistorySettings') });
  m('components/pages/settings/NativeControlStatus.tsx', { NativeControlStatus: stub('NativeControlStatus') });
  m('components/pages/settings/MigrationReport.tsx', { MigrationAdvanced: stub('MigrationAdvanced') });
  m('components/browser/ClaudeInChromeNote.tsx', { ClaudeInChromeNote: stub('ClaudeInChromeNote') });
  m('components/pages/settings/BrowserImportData.tsx', { BrowserImportData: stub('BrowserImportData') });
  m('lib/flags.ts', { isEnabled: (k: string) => ctl.flags[k] ?? true });
  m('lib/environments.ts', {
    readEnvironment: record('readEnvironment', async () => {
      if (ctl.env instanceof Error) throw ctl.env;
      return typeof ctl.env === 'function' ? ctl.env() : ctl.env;
    }),
    resolveEnvironment: record('resolveEnvironment', async () => {
      if (ctl.resolved instanceof Error) throw ctl.resolved;
      return resolvedEnvironment({ source: ctl.env ? 'environment' : null, ...ctl.resolved });
    }),
    convertEnvironment: record('convertEnvironment', (...a: any[]) => ctl.convertEnv(...a)),
    writeEnvironment: record('writeEnvironment', (...a: any[]) => ctl.writeEnv(...a)),
    envPath: (root: string) => `${root}/.codex/environments/environment.toml`,
  });
  m('components/ui/Popover.tsx', {
    Popover: ({ open, children }: any) => (open ? h('div', { className: 'popover' }, children) : null),
    Menu: ({ open, children }: any) => (open ? h('div', { className: 'menu' }, children) : null),
    MenuItem: ({ children, checked, onSelect, icon, description, right, disabled, title }: any) =>
      h(
        'button',
        { className: 'menu-item', 'aria-checked': checked == null ? undefined : String(!!checked), disabled, title, onClick: onSelect },
        icon,
        children,
        description,
        right,
      ),
    SubMenu: ({ label, description, shortcut, icon, children }: any) =>
      h('div', { className: 'submenu' }, h('div', { className: 'submenu-label' }, icon, label, description, shortcut), children),
    MenuSeparator: () => h('hr'),
    MenuLabel: ({ children }: any) => h('header', null, children),
    useAnchor: () => {
      const [open, setOpen] = React.useState(false);
      return { ref: () => {}, anchor: null, open, setOpen, toggle: () => setOpen((o: boolean) => !o), close: () => setOpen(false) };
    },
    Tooltip: ({ children }: any) => children,
  });
  // a component that imports a store slice gets the store's stand-ins there
  for (const [rel, all] of Object.entries(storeSliceStubs(storeStubs))) m(rel, { ...all, ...mocks[url(rel)] });
  (globalThis as any).confirm = (msg: string) => {
    calls.push(['confirm', msg]);
    return ctl.confirm;
  };
  (globalThis as any).Audio = class {
    src: string;
    constructor(src: string) {
      this.src = src;
    }
    play() {
      calls.push(['play', this.src]);
    }
  };
  (window.location as any).reload = () => calls.push(['reload']);
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */
export async function render(el: any) {
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    host,
    rerender: (next: any) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
export const act = async (fn: () => any) =>
  (await import('react')).act(async () => {
    await fn();
  });
export const flush = (ms = 0) => act(() => new Promise((r) => setTimeout(r, ms)));
export const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
export const buttons = (root: Element, label: string) =>
  [...root.querySelectorAll('button')].filter((b) => text(b) === label || b.getAttribute('aria-label') === label) as HTMLButtonElement[];
export function button(root: Element, label: string): HTMLButtonElement {
  const b = buttons(root, label)[0];
  if (!b) throw new Error(`no button "${label}" in: ${text(root)}`);
  return b;
}
/** The settings row titled `title`, else the first whose title starts with it. */
export function row(root: Element, title: string): HTMLElement {
  const rows = [...root.querySelectorAll('.settings-row')];
  const title_ = (x: Element) => text(x.querySelector('.settings-row-title'));
  const r = rows.find((x) => title_(x) === title) ?? rows.find((x) => title_(x).startsWith(title));
  if (!r) throw new Error(`no row "${title}" in: ${text(root)}`);
  return r as HTMLElement;
}
export const click = (el: Element) => act(() => (el as HTMLElement).click());
export const toggle = (root: Element, title: string) => click(row(root, title).querySelector('[role=switch]')!);
/** Opens a Select (unless a menu in `scope` is already open) and picks the option labelled `label`. */
export async function pick(scope: Element, label: string, index = 0) {
  if (!scope.querySelector('.menu')) await click(scope.querySelectorAll('.select-btn')[index]);
  const item = [...scope.querySelectorAll('.menu .menu-item')].find((b) => text(b) === label);
  if (!item) throw new Error(`no option "${label}" in: ${text(scope.querySelector('.menu'))}`);
  await click(item);
}
export const options = (scope: Element) => [...scope.querySelectorAll('.menu .menu-item')].map((b) => text(b));
export function setValue(el: Element, value: string, event = 'input') {
  return act(() => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event(event, { bubbles: true }) as any);
  });
}
export const key = (target: EventTarget, init: Record<string, any>) =>
  act(() => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }) as any);
  });
export const blur = (el: Element) =>
  act(() => {
    el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }) as any);
  });
export const lastPrefs = () => [...calls].reverse().find((c) => c[0] === 'setPrefs')?.[1];
