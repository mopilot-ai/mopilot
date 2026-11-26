// MoMo's gate in the main window (src/App.tsx, src/session/appShortcuts.ts): an account MoMo is not allowed for gets no MoMo column and a no-op momo command; the shell fixture is a copy of tests/appShell.test.ts's, with src/lib/momo.ts under this test's control.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { controlledReads } from './support/async-scenarios.ts';
import { SHORTCUT_ACTIONS } from '../shared/shortcuts.mjs';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { shellPanels, stubStore } from './support/stubs.ts';

const { createElement: h, act, useSyncExternalStore } = await import('react');
const { createRoot } = await import('react-dom/client');

const listeners = new Set<() => void>();
let state: any;
const notify = () => listeners.forEach((cb) => cb());
const setState = (p: any) => {
  state = { ...state, ...(typeof p === 'function' ? p(state) : p) };
  notify();
};
const useStore = (sel: (s: any) => any) =>
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => sel(state),
  );
const calls: unknown[][] = [];
const rec =
  (name: string, ret?: unknown) =>
  (...a: unknown[]) => (calls.push([name, ...a]), ret);
let welcomeOpen = false;
const welcomeListeners = new Set<() => void>();
let onCommand: (cmd: string, arg?: unknown) => unknown = () => {};
let folder: string | null = null;
let projectId: string | null = 'p1';
let winOpenResult: unknown;
let folderResult: Promise<string | null> | undefined;
let projectResult: Promise<string | null> | undefined;
let groupsValue: any = { groups: [{ threads: [{ id: 'a' }, { id: 'b' }] }], recents: [{ id: 'c' }] };

function reset(over: any = {}) {
  state = {
    route: { name: 'home' },
    ...shellPanels({ summaryOpen: false }),
    diffPanel: { open: false },
    bottomPanelOpen: false,
    focused: true,
    prefs: { fontSize: 14, codeFontSize: 12, keybindings: {} },
    paneFull: false,
    threads: { a: { cwd: '/a' }, b: {}, c: {} },
    unread: {},
    pending: [],
    pinned: {},
    paneTabs: [],
    paneActive: '',
    threadOrder: ['c', 'a', 'b'],
    savedProjects: [],
    chatProject: {},
    activityView: false,
    codexOk: true,
    anyUsable: true,
    checking: false,
    dark: true,
    ...over,
  };
  calls.length = 0;
  welcomeOpen = false;
}
reset();

const stub = (name: string) => (props: any) =>
  h(
    'div',
    { 'data-c': name, 'data-p': JSON.stringify(props, (k, v) => (typeof v === 'function' ? undefined : k === 'children' ? undefined : v)) },
    props.children,
  );
const stubs = (...names: string[]) => Object.fromEntries(names.map((n) => [n, stub(n)]));

mock.module('../src/lib/platform.ts', {
  namedExports: {
    isWin: false,
    platform: 'darwin',
    shellScript: (s: string) => ['/bin/zsh', '-lc', s],
    modKey: (e: any) => e.metaKey,
    terminalTitle: (cwd: string) => `term:${cwd}`,
  },
});
mock.module('../src/session/harness/billing.ts', {
  namedExports: { startLimitWatch: () => (calls.push(['limitWatch']), () => calls.push(['limitWatchOff'])) },
});
stubStore({
  useStore,
  chatOf: (id: string) => id,
  threadTitle: (t: any) => t?.name ?? 'Chat',
  renameThread: rec('renameThread', Promise.resolve()),
  projectForThread: (t: any, projects: any[]) => projects.find((p) => p.id === t.projectId),
  closePaneTab: rec('closePaneTab'),
  toastFailure: (message: string) => (e: unknown) => calls.push(['error', message, e]),
  setState,
  getState: () => state,
  navigate: (r: any) => (calls.push(['navigate', r]), setState({ route: r })),
  goBack: rec('back'),
  goForward: rec('forward'),
  leaveSettings: rec('leaveSettings'),
  cycleSplitFocus: rec('cycleSplitFocus'),
  closeFocusedSplit: rec('closeFocusedSplit'),
  createProject: async (p: string) => (calls.push(['createProject', p]), projectResult ?? projectId),
  currentCwdForNewChat: () => '/new',
  newChatHostPick: () => null,
  toast: rec('toast'),
  togglePaneTab: rec('togglePaneTab'),
  openPaneTab: rec('openPaneTab'),
  openAgentBrowserTab: rec('agentTab'),
  openBrowserViewTab: rec('browserViewTab'),
  closeAgentBrowserTab: rec('closeAgentTab'),
  selectAgentBrowserTab: rec('selectAgentTab'),
  setPrefs: rec('setPrefs'),
  codexUsable: (s: any) => s.codexOk,
  claudeUsable: (s: any) => !!s.claudeOk,
  anyHarnessUsable: (s: any) => s.anyUsable,
  harnessesChecking: (s: any) => s.checking,
  resetNewChatDefaults: rec('resetDefaults'),
  clearNewChatProject: rec('clearProject'),
  giveBackToComposer: rec('giveBack'),
  temporaryChatBlocked: (s: any) => s.tempBlocked ?? null,
  archiveThread: rec('archive'),
  openSideChat: rec('sideChat'),
  openChanges: rec('openChanges'),
});
installNativeStub({
  win: {
    mini: rec('mini', Promise.resolve()),
    open: (...args: unknown[]) => {
      calls.push(['winOpen', ...args]);
      return winOpenResult;
    },
    setTitleBarOverlay: rec('overlay', Promise.resolve()),
  },
  dialog: { openFolder: async () => folderResult ?? folder },
  app: { onCommand: (cb: any) => ((onCommand = cb), () => calls.push(['offCommand'])) },
});
const envReads = controlledReads<any>();
const envRoots: string[] = [];
mock.module('../src/lib/environments.ts', {
  namedExports: {
    resolveEnvironment: (root: string) => {
      envRoots.push(root);
      return envReads.read();
    },
  },
});
mock.module('../src/session/voice.ts', { namedExports: { startVoiceChat: rec('voice') } });
// copying confirms only after the write (src/session/clipboard.ts, tests/clipboard.test.ts); here it records the copy and its toast
const writes: string[] = [];
mock.module('../src/session/clipboard.ts', {
  namedExports: { copyText: (t: string, done: string) => (writes.push(t), calls.push(['toast', done])) },
});
mock.module('../src/session/harness/select.ts', {
  namedExports: { logoutRoute: (id: string | null) => ({ name: 'settings', section: 'accounts', tab: `logout:${id}` }) },
});
// how new chats start is its own (tests/newChatStart.test.ts)
mock.module('../src/session/newChatStart.ts', { namedExports: { applyNewChatDefault: () => {} } });
mock.module('../src/session/updates.ts', { namedExports: { useUpdatePrefsSync: () => {} } });
let _resizeProps: any = null;
mock.module('../src/components/sidebar/SidebarResize.tsx', {
  namedExports: {
    SidebarResize: (p: any) => {
      _resizeProps = p;
      return stub('SidebarResize')(p);
    },
  },
});
mock.module('../src/store/agentWiring.ts', { namedExports: { moveToBackground: rec('moveToBackground') } });
mock.module('../src/components/titleBar/TitleBar.tsx', { namedExports: stubs('TitleBar') });
mock.module('../src/components/sidebar/PageNavColumn.tsx', { namedExports: stubs('PageNavColumn') });
mock.module('../src/components/momo/MomoNav.tsx', { namedExports: stubs('MomoNav') });
mock.module('../src/components/momo/MomoRoute.tsx', { namedExports: { MomoRoute: () => null } });
let momoAllowed = true;
mock.module('../src/lib/momo.ts', {
  namedExports: {
    useMomoAllowed: () => momoAllowed,
    useMomoAccess: () => ({ allowed: momoAllowed, known: true }),
    momoAllowedNow: () => momoAllowed,
  },
});
// the sidebar's groups follow every chat's metadata, as the real hook does
mock.module('../src/components/sidebar/Sidebar.tsx', {
  namedExports: { ...stubs('Sidebar'), useProjectGroups: () => (useStore((s) => s.threads), groupsValue) },
});
mock.module('../src/components/pages/Home.tsx', { namedExports: stubs('Home') });
mock.module('../src/components/thread/ThreadView.tsx', { namedExports: stubs('ThreadView') });
mock.module('../src/components/split/SplitFrame.tsx', { namedExports: stubs('SplitFrame') });
mock.module('../src/components/panels/SummaryPanel.tsx', { namedExports: stubs('SummaryPanel') });
mock.module('../src/components/panels/SummarySlot.ts', { namedExports: stubs('SummarySlot') });
mock.module('../src/components/panels/SidePane.tsx', { namedExports: stubs('SidePane') });
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: stubs('TerminalPanel') });
const Settings = Object.assign(stub('Settings'), { Nav: stub('SettingsNav') });
mock.module('../src/components/pages/Settings.tsx', { namedExports: { Settings, SHORTCUT_ACTIONS } });
mock.module('../src/components/harness/codex/Plugins.tsx', { namedExports: stubs('Plugins', 'PluginsNav') });
mock.module('../src/components/pages/Scheduled.tsx', { namedExports: stubs('Scheduled', 'ScheduledNav') });
mock.module('../src/components/pages/Review.tsx', { namedExports: stubs('Review', 'ReviewNav') });
mock.module('../src/components/pages/Projects.tsx', { namedExports: stubs('Projects') });
mock.module('../src/components/pages/CloudTask.tsx', { namedExports: stubs('CloudTask') });
mock.module('../src/components/search/SearchPalette.tsx', { namedExports: stubs('SearchPalette') });
mock.module('../src/components/tasks/RunningTaskPollers.tsx', { namedExports: stubs('RunningTaskPollers') });
mock.module('../src/components/dialogs/Dialogs.tsx', { namedExports: stubs('Dialogs') });
mock.module('../src/components/pages/settings/AddMachineDialog.tsx', { namedExports: { AddMachineDialog: () => null } });
mock.module('../src/components/ui/Toasts.tsx', { namedExports: stubs('Toasts') });
mock.module('../src/components/pages/Login.tsx', { namedExports: stubs('CodexNotice') });
mock.module('../src/components/pages/Welcome.tsx', { namedExports: stubs('Welcome') });
mock.module('../src/components/pages/welcomeState.ts', {
  namedExports: {
    useWelcome: (sel: (s: any) => any) =>
      useSyncExternalStore(
        (cb) => (welcomeListeners.add(cb), () => welcomeListeners.delete(cb)),
        () => sel({ open: welcomeOpen }),
      ),
    openWelcome: () => {
      calls.push(['openWelcome']);
    },
  },
});
mock.module('../src/components/accounts/Accounts.tsx', { namedExports: stubs('AccountSignInDialog', 'AccountExpiredBanner') });
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: { useResolvedDark: () => useStore((s) => s.dark) } });
mock.module('../src/components/ui/ErrorBoundary.tsx', { namedExports: stubs('ErrorBoundary') });
const { App } = await import('../src/App.tsx');

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(h(App)));
}
async function unmount() {
  await act(() => root.unmount());
  host.remove();
}
const shown = () => [...host.querySelectorAll('[data-c]')].map((e) => (e as HTMLElement).dataset.c).join(' ');
const set = (p: any) => act(async () => setState(p));
const cmd = (c: string, arg?: unknown) =>
  act(async () => {
    await onCommand(c, arg);
  });

test('the MoMo column shows only while MoMo is allowed, and not yet known counts as not allowed', async () => {
  reset({ route: { name: 'momo', tab: 'memory' } });
  await mount();
  assert.match(shown(), /PageNavColumn MomoNav/);
  momoAllowed = false;
  await set({ route: { name: 'momo', tab: 'chat' } });
  assert.doesNotMatch(shown(), /MomoNav/);
  momoAllowed = true;
  await unmount();
});

test('the momo command opens MoMo only while it is allowed', async () => {
  reset({ route: { name: 'thread', id: 'c' } });
  await mount();
  momoAllowed = false;
  await cmd('momo', { kind: 'chat', chatId: 'mc1' });
  assert.deepEqual(state.route, { name: 'thread', id: 'c' });
  momoAllowed = true;
  await cmd('momo', { kind: 'chat', chatId: 'mc1' });
  assert.deepEqual(state.route, { name: 'momo', tab: 'chat', chatId: 'mc1' });
  await unmount();
});
