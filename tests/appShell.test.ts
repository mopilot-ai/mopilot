// The main window (src/App.tsx): which page shows for the route and harness state, the theme on <html>, and the menu commands and keyboard shortcuts. Every page and panel is a stub; the store is a fake.
import { rendersOf, resetCommits } from './support/commitProbe.ts'; // first: React reads the hook as it loads
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerAppShellPanelCases } from './support/app-shell-panels.ts';
import { registerShortcutDispatchCases } from './support/shortcut-dispatch-cases.ts';
import { controlledReads } from './support/async-scenarios.ts';
import { SHORTCUT_ACTIONS } from '../shared/shortcuts.mjs';
import { window } from './support/dom.ts';
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
let folderResult: Promise<string | null> | undefined, projectResult: Promise<string | null> | undefined;
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
  newChatHostPick: () => state.newChatHost ?? null,
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
  momo: { access: async () => true, onAccess: () => () => {} },
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
// how new chats start is its own (tests/newChatStart.test.ts): here only that the tray's New Chat starts from it
mock.module('../src/session/newChatStart.ts', { namedExports: { applyNewChatDefault: rec('applyNewChatDefault') } });
mock.module('../src/session/updates.ts', { namedExports: { useUpdatePrefsSync: () => {} } });
let resizeProps: any = null;
mock.module('../src/components/sidebar/SidebarResize.tsx', {
  namedExports: {
    SidebarResize: (p: any) => {
      resizeProps = p;
      return stub('SidebarResize')(p);
    },
  },
});
mock.module('../src/store/agentWiring.ts', { namedExports: { moveToBackground: rec('moveToBackground') } });
mock.module('../src/components/titleBar/TitleBar.tsx', { namedExports: stubs('TitleBar') });
mock.module('../src/components/sidebar/PageNavColumn.tsx', { namedExports: stubs('PageNavColumn') });
mock.module('../src/components/momo/MomoNav.tsx', { namedExports: stubs('MomoNav') });
mock.module('../src/components/momo/MomoRoute.tsx', { namedExports: { MomoRoute: () => null } });
// the sidebar's groups follow every chat's metadata, as the real hook does
mock.module('../src/components/sidebar/Sidebar.tsx', {
  namedExports: { ...stubs('Sidebar'), useProjectGroups: () => (useStore((s) => s.threads), groupsValue) },
});
for (const n of ['Home', 'Projects']) mock.module(`../src/components/pages/${n}.tsx`, { namedExports: stubs(n) });
mock.module('../src/components/thread/ThreadView.tsx', { namedExports: stubs('ThreadView') });
mock.module('../src/components/split/SplitFrame.tsx', { namedExports: stubs('SplitFrame') });
mock.module('../src/components/panels/SummaryPanel.tsx', { namedExports: stubs('SummaryPanel') });
mock.module('../src/components/panels/SummarySlot.ts', { namedExports: stubs('SummarySlot') });
mock.module('../src/components/panels/SidePane.tsx', { namedExports: stubs('SidePane') });
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: stubs('TerminalPanel') });
const Settings = Object.assign(stub('Settings'), { Nav: stub('SettingsNav') });
mock.module('../src/components/pages/Settings.tsx', { namedExports: { Settings, SHORTCUT_ACTIONS } });
mock.module('../src/components/harness/codex/Plugins.tsx', { namedExports: stubs('Plugins', 'PluginsNav') });
for (const n of ['Scheduled', 'Review']) mock.module(`../src/components/pages/${n}.tsx`, { namedExports: stubs(n, `${n}Nav`) });
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
const props = (name: string) => JSON.parse((host.querySelector(`[data-c="${name}"]`) as HTMLElement).dataset.p!);
const set = (p: any) => act(async () => setState(p));
const cmd = (c: string, arg?: unknown) =>
  act(async () => {
    await onCommand(c, arg);
  });
const key = (init: KeyboardEventInit) =>
  act(async () => {
    const e = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init } as any);
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });

test('home with a usable harness shows the app; theme and appearance go on <html>', async () => {
  reset();
  document.documentElement.style.setProperty('--stale', '1');
  await mount();
  assert.equal(
    shown(),
    'TitleBar Sidebar SidebarResize SplitFrame AccountExpiredBanner Home SummarySlot RunningTaskPollers SearchPalette Dialogs AccountSignInDialog Toasts',
  );
  assert.equal(host.querySelector('.app')!.className, 'app focused');
  assert.equal((host.querySelector('.app') as HTMLElement).style.getPropertyValue('--sidebar-w'), '288px');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.documentElement.style.getPropertyValue('--stale'), '');
  assert.equal(document.documentElement.style.getPropertyValue('--fs-chat'), '14px');
  await set({ dark: false, focused: false, prefs: { ...state.prefs, sidebarWidth: 300 } });
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(host.querySelector('.app')!.className, 'app blurred');
  assert.equal(props('Sidebar').width, 300);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'limitWatch'),
    [['limitWatch']],
  );
  // the resize edge opens or closes the sidebar and saves the width it was dragged to
  await act(async () => resizeProps.onSaveWidth(320));
  assert.deepEqual(calls.filter((c) => c[0] === 'setPrefs').at(-1), ['setPrefs', { sidebarWidth: 320 }]);
  await act(async () => resizeProps.onOpenChange(false));
  assert.equal(state.sidebarOpen, false);
  await act(async () => resizeProps.onOpenChange(true));
  assert.equal(state.sidebarOpen, true);
  // the saved width is clamped to the window as it resizes, and beside a side pane, without rewriting the preference
  const saves = calls.filter((c) => c[0] === 'setPrefs').length;
  await set({ prefs: { ...state.prefs, sidebarWidth: 560 } });
  const width = () => (host.querySelector('.app') as HTMLElement).style.getPropertyValue('--sidebar-w');
  const resize = (w: number) =>
    act(async () => {
      (window as any).innerWidth = w;
      window.dispatchEvent(new window.Event('resize'));
    });
  await resize(1600);
  assert.equal(width(), '560px');
  await set({ diffPanel: { open: true } });
  assert.equal(width(), '560px', 'a 1600 window holds the sidebar, the chat and the pane');
  assert.equal(resizeProps.beside, 400);
  await resize(1384);
  assert.equal(width(), '544px', 'the chat keeps 440 and the pane 400');
  await set({ diffPanel: { open: false } });
  assert.equal(width(), '560px');
  assert.equal(calls.filter((c) => c[0] === 'setPrefs').length, saves);
  await resize(1024);
  await unmount();
  assert.deepEqual(
    calls
      .slice(-2)
      .map((c) => c[0])
      .sort(),
    ['limitWatchOff', 'offCommand'],
  );
});

test('each route shows its page', async () => {
  reset();
  await mount();
  const page = async (route: any, over: any = {}) => {
    await set({ route, ...over });
    return shown();
  };
  assert.match(await page({ name: 'thread', id: 'a' }), /ErrorBoundary ThreadView SummarySlot SummaryPanel/);
  assert.equal(props('ThreadView').threadId, 'a');
  assert.match(await page({ name: 'plugins', tab: 'x', plugin: 'p' }), /PageNavColumn PluginsNav .*Plugins SummarySlot/);
  assert.match(await page({ name: 'scheduled' }), /PageNavColumn ScheduledNav .*Scheduled SummarySlot/);
  assert.match(await page({ name: 'review' }), /PageNavColumn ReviewNav .*Review SummarySlot/);
  assert.match(await page({ name: 'momo', tab: 'memory' }), /PageNavColumn MomoNav/);
  assert.equal(props('MomoNav').tab, 'memory');
  assert.doesNotMatch(await page({ name: 'review' }, { sidebarOpen: false }), /ReviewNav/);
  assert.match(shown(), /Review/);
  assert.match(await page({ name: 'projects' }, { sidebarOpen: true }), /Projects/);
  assert.match(await page({ name: 'cloud', id: 't1' }), /CloudTask/);
  assert.equal(props('CloudTask').id, 't1');
  assert.match(await page({ name: 'cloud', id: 't1' }, { codexOk: false }), /CodexNotice/);
  assert.doesNotMatch(shown(), /CloudTask/);
  assert.equal(
    (await page({ name: 'settings', section: 'general' })).replace('Sidebar ', ''),
    'TitleBar SettingsNav SplitFrame Settings SummarySlot RunningTaskPollers SearchPalette Dialogs AccountSignInDialog Toasts',
  );
  assert.equal(props('Sidebar').leaving, true);
  await unmount();
});

registerAppShellPanelCases({ reset, mount, unmount, set, props, getHost: () => host });

test("a chat's metadata re-renders only the shortcuts' leaf; the open chat's folder re-renders the app", async () => {
  reset({ route: { name: 'thread', id: 'a' }, bottomPanelOpen: true });
  await mount();
  resetCommits();
  await set((s: any) => ({ threads: { ...s.threads, a: { cwd: '/a', name: 'Renamed' }, b: { name: 'Other' } } }));
  assert.deepEqual(rendersOf('App'), []);
  assert.equal(rendersOf('AppShortcuts').length, 1);
  await set((s: any) => ({ threads: { ...s.threads, a: { cwd: '/moved', name: 'Renamed' } } }));
  assert.equal(rendersOf('App').length, 1);
  assert.equal(props('TerminalPanel').cwd, '/moved');
  await unmount();
});

test('harness gates: welcome, checking spinner, and staying open during a re-check', async () => {
  reset({ anyUsable: false, checking: true });
  await mount();
  assert.ok(host.querySelector('.center-fill .spinner'));
  assert.doesNotMatch(shown(), /Home/);
  await set({ checking: false });
  assert.match(shown(), /Welcome/);
  assert.deepEqual(calls.filter((c) => c[0] === 'openWelcome').length, 1);
  await set({ anyUsable: true });
  assert.match(shown(), /Home/);
  await set({ anyUsable: false, checking: true });
  assert.match(shown(), /Home/);
  assert.equal(host.querySelector('.center-fill') === null, true);
  welcomeOpen = true;
  await act(async () => welcomeListeners.forEach((cb) => cb()));
  assert.match(shown(), /Welcome/);
  await set({ route: { name: 'settings' } });
  assert.doesNotMatch(shown(), /Welcome/);
  await unmount();
});

test('a new install is welcomed while only a basic harness works (#2034); the decision: tests/welcome.test.ts welcomeDue', async () => {
  reset({ codexOk: false, anyUsable: true, home: '/h', prefs: { fontSize: 14, codeFontSize: 12, keybindings: {}, welcomeDone: false } });
  await mount();
  assert.equal(calls.filter((c) => c[0] === 'openWelcome').length, 1);
  await unmount();
});

test('menu commands', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const focusEvents: string[] = [];
  const onFocus = () => focusEvents.push('focus-composer');
  window.addEventListener('focus-composer', onFocus);
  writes.length = 0;
  try {
    reset({ route: { name: 'thread', id: 'a' }, unread: { b: true } });
    await mount();
    await cmd('settings', 5);
    assert.deepEqual(state.route, { name: 'settings', section: undefined });
    await cmd('settings', 'general');
    assert.deepEqual(state.route, { name: 'settings', section: 'general' });
    calls.length = 0;
    await cmd('new-chat-default');
    assert.equal(state.newChatTemporary, false);
    // the draft starts over, from Settings' fixed default when new chats use one
    assert.deepEqual(
      calls.slice(0, 2).map((c) => c[0]),
      ['resetDefaults', 'applyNewChatDefault'],
    );
    // refused, with why, when the harness it would run on can't run here
    state.tempBlocked = 'Sign in first';
    await cmd('new-temp-chat');
    assert.deepEqual([state.newChatTemporary, calls.at(-1)], [false, ['toast', 'Sign in first', 'error']]);
    state.tempBlocked = null;
    await cmd('new-temp-chat');
    assert.equal(state.newChatTemporary, true);
    mock.timers.tick(50);
    assert.deepEqual(focusEvents, ['focus-composer']);
    assert.deepEqual(
      calls.filter((c) => c[0] === 'resetDefaults' || c[0] === 'clearProject'),
      [['resetDefaults'], ['clearProject', true]],
    );
    // the Chrome extension's Try it: a new chat with the task drafted, not sent; no text, no draft
    await cmd('new-chat-draft', 'Open news.ycombinator.com');
    mock.timers.tick(100);
    assert.deepEqual(calls.at(-1), ['giveBack', null, 'Open news.ycombinator.com']);
    await cmd('new-chat-draft', 7);
    assert.notDeepEqual(calls.at(-1)?.[0], 'giveBack');
    await cmd('scheduled'); // Chrome's side panel opening the Scheduled page
    assert.deepEqual(state.route, { name: 'scheduled' });
    // open folder: cancelled, new project, project not created
    await cmd('open-folder');
    folder = '/picked';
    await cmd('open-folder');
    assert.equal(state.newChatProjectId, 'p1');
    assert.deepEqual(state.route, { name: 'home', cwd: '/picked' });
    projectId = null;
    state.newChatProjectId = 'keep';
    await cmd('open-folder');
    assert.equal(state.newChatProjectId, 'keep');
    folder = null;
    projectId = 'p1';
    await cmd('toggle-sidebar');
    assert.equal(state.sidebarOpen, false);
    await cmd('toggle-bottom-panel');
    assert.equal(state.bottomPanelOpen, true);
    await cmd('open-terminal');
    assert.equal(state.bottomPanelOpen, false);
    await set({ prefs: { ...state.prefs, defaultTerminal: 'right' }, route: { name: 'thread', id: 'a' } });
    await cmd('open-terminal');
    await set({ route: { name: 'home' } });
    await cmd('open-terminal');
    assert.deepEqual(calls.filter((c) => c[0] === 'openPaneTab').slice(-2), [
      ['openPaneTab', 'terminal', { cwd: '/a', title: 'term:/a' }],
      ['openPaneTab', 'terminal', { cwd: '/new', title: 'term:/new' }],
    ]);
    await cmd('toggle-summary');
    assert.equal(state.summaryOpen, true);
    await cmd('search');
    await cmd('shortcut', 'command-menu');
    assert.equal(state.searchOpen, true);
    await cmd('search-files');
    assert.equal(state.searchMode, 'files');
    await cmd('toggle-activity');
    assert.equal(state.activityView, true);
    // prev/next chat wrap around the sidebar order; from a non-thread page they start at the ends
    await set({ route: { name: 'home' } });
    await cmd('next-chat');
    assert.equal(state.route.id, 'a');
    await cmd('prev-chat');
    assert.equal(state.route.id, 'c');
    await cmd('next-chat');
    assert.equal(state.route.id, 'a');
    await cmd('back');
    await cmd('forward');
    await cmd('shortcuts');
    assert.deepEqual(state.route, { name: 'settings', section: 'shortcuts' });
    await cmd('logout');
    assert.equal(state.route.tab, 'logout:null');
    await set({ route: { name: 'thread', id: 'b' } });
    await cmd('logout');
    assert.equal(state.route.tab, 'logout:b');
    await cmd('toggle-changes');
    await cmd('open-changes');
    await cmd('toggle-files');
    await cmd('open-chat', 'missing');
    await cmd('open-chat', 7);
    await cmd('momo', { kind: 'chat', chatId: 'mc1' });
    assert.deepEqual(state.route, { name: 'momo', tab: 'chat', chatId: 'mc1' }, 'a MoMo notice opens MoMo at its chat (lib/momoRoute.ts)');
    await cmd('open-chat', 'c');
    assert.deepEqual(state.route, { name: 'thread', id: 'c' });
    await cmd('open-browser-tab', 'https://x');
    await cmd('open-browser-tab');
    await cmd('open-agent-browser-tab', 'https://y');
    await cmd('open-agent-browser-tab');
    await cmd('new-standalone');
    assert.equal(state.newChatProjectId, 'none');
    await cmd('copy-cwd');
    await set({ route: { name: 'home' } });
    await cmd('copy-cwd');
    assert.deepEqual(writes, ['/new', '/new']);
    await set({ route: { name: 'thread', id: 'a' } });
    await cmd('copy-cwd');
    assert.deepEqual(writes.at(-1), '/a');
    await cmd('next-attention');
    assert.equal(state.route.id, 'b');
    await set({ unread: {}, pending: [{ threadId: 'c' }] });
    await cmd('next-attention');
    assert.equal(state.route.id, 'c');
    await cmd('clear-unreads');
    await set({ pending: [] });
    await cmd('next-attention');
    assert.equal(state.route.id, 'c');
    await cmd('start-voice');
    await set({ route: { name: 'home' } });
    await cmd('start-voice');
    await cmd('about');
    assert.deepEqual(state.route, { name: 'settings', section: 'about' });
    await cmd('unknown-command');
    assert.deepEqual(
      calls.filter((c) => ['back', 'forward', 'togglePaneTab', 'openChanges', 'agentTab', 'toast', 'voice'].includes(c[0] as string)),
      [
        ['toast', 'Sign in first', 'error'],
        ['back'],
        ['forward'],
        ['togglePaneTab', 'changes'],
        ['openChanges'],
        ['togglePaneTab', 'files'],
        ['agentTab', 'https://y'],
        ['toast', 'Copied working directory'],
        ['toast', 'Copied working directory'],
        ['toast', 'Copied working directory'],
      ],
    );
    assert.deepEqual(
      calls.filter((c) => c[0] === 'openPaneTab' && c[1] === 'browser'),
      [
        ['openPaneTab', 'browser', { url: 'https://x', title: 'https://x' }],
        ['openPaneTab', 'browser', {}],
      ],
    );
    // with no chats, stepping does nothing
    groupsValue = { groups: [], recents: [] };
    await act(async () => root.render(h(App)));
    const before = state.route;
    await cmd('next-chat');
    assert.equal(state.route, before);
    await unmount();
  } finally {
    groupsValue = { groups: [{ threads: [{ id: 'a' }, { id: 'b' }] }], recents: [{ id: 'c' }] };
    window.removeEventListener('focus-composer', onFocus);
    mock.timers.reset();
  }
});

// moved from tests/agentBrowserTabsStore.test.ts: agentTabRequest reads the agent-tab commands' argument
test('the agent-tab commands reach the store as agentTabRequest reads them (tests/agentTabRequest.test.ts), and bad ones do not', async () => {
  reset();
  await mount();
  try {
    const tabCalls = () => calls.filter((c) => ['agentTab', 'closeAgentTab', 'selectAgentTab'].includes(c[0] as string));
    await cmd('open-agent-browser-tab', { chatId: 'chat1', tabKey: 'tab_aa1111', focus: false, after: 'tab_bb2222' });
    await cmd('close-agent-browser-tab', { chatId: 'chat1', tabKey: 'tab_aa1111' });
    await cmd('select-agent-browser-tab', { chatId: 'chat1' });
    await cmd('open-agent-browser-tab', { chatId: 'chat1', tabKey: 'tab_aa1111', focus: true, auto: true });
    await cmd('select-agent-browser-tab', { chatId: 'chat1', tabKey: 'tab_aa1111', auto: true });
    // a view tab's popup main opened: the store checks the request
    await cmd('open-browser-view', { paneId: 'browser-p', url: 'https://a.test/' });
    assert.deepEqual(
      calls.filter((c) => c[0] === 'browserViewTab'),
      [['browserViewTab', { paneId: 'browser-p', url: 'https://a.test/' }]],
    );
    assert.deepEqual(tabCalls(), [
      ['agentTab', 'chat1', { tabKey: 'tab_aa1111', focus: false, after: 'tab_bb2222' }],
      ['closeAgentTab', 'chat1', 'tab_aa1111'],
      ['selectAgentTab', 'chat1', null, false],
      ['agentTab', 'chat1', { tabKey: 'tab_aa1111', focus: true, auto: true }],
      ['selectAgentTab', 'chat1', 'tab_aa1111', true],
    ]);
    calls.length = 0;
    for (const bad of [null, undefined, 'chat1', 3, {}, { chatId: '' }, { chatId: 5 }]) {
      if (typeof bad !== 'string') await cmd('open-agent-browser-tab', bad);
      await cmd('close-agent-browser-tab', bad);
      await cmd('select-agent-browser-tab', bad);
    }
    assert.deepEqual(tabCalls(), []);
  } finally {
    await unmount();
  }
});

registerShortcutDispatchCases({
  setGroups: (value: any) => {
    groupsValue = value;
  },
  reset,
  mount,
  cmd,
  set,
  key,
  calls,
  writes,
  unmount,
  getState: () => state,
  onCommand: (...args: Parameters<typeof onCommand>) => onCommand(...args),
  envReads,
  envRoots,
  setWinOpenResult: (value: unknown) => {
    winOpenResult = value;
  },
  setFolderResult: (value: Promise<string | null> | undefined) => {
    folderResult = value;
  },
  setProjectResult: (value: Promise<string | null> | undefined) => {
    projectResult = value;
  },
});
