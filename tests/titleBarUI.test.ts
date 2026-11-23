import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { shellPanels, stubStore } from './support/stubs.ts';
import { createElement, act } from 'react';
import { fakeStore, popoverExports, render, click, byText, maybeText, press, flush } from './support/shell-chrome-kit.ts';
import { browserTabMenuTests, tabMenuStoreExports } from './support/titleBarTabMenu.ts';
import { titleBarLayoutTests } from './support/titleBarLayout.ts';
import { shellScript } from '../src/lib/platform.ts';
import { installNativeStub } from './support/ports/native.ts';

export const GUARDS = ['src/'];

mock.module('../src/store/browserDuplicate.ts', {
  namedExports: { browserDuplication: { duplicate: async (id: string) => calls.push(['duplicate', id]) } },
});
const THREAD = { id: 'codex:t1', title: 'Fix: the <bug>?', cwd: '/work/app', projectId: 'p1' };
const initial = (patch: any = {}) => ({
  route: { name: 'thread', id: 'codex:t1' },
  back: [],
  forward: [],
  ...shellPanels({ summaryOpen: false }),
  bottomPanelOpen: false,
  paneTabs: [],
  paneActive: null,
  paneFull: false,
  prefs: { bottomPanelControl: false, openDestination: 'cursor' },
  fullscreen: false,
  threads: { 'codex:t1': THREAD },
  pinned: {},
  savedProjects: [{ id: 'p1', roots: [{ path: '/work/root' }] }],
  diffPanel: { open: false },
  paneWidth: 400,
  runtime: {},
  segments: {},
  chatConfig: {},
  ...patch,
});
const store = fakeStore<any>(initial());
const calls: any[] = [];
// handlers passed straight to onClick get the React event; record it as a marker, not the event graph
const log =
  (name: string) =>
  (...a: any[]) => {
    calls.push([name, ...a.map((x) => (x && typeof x === 'object' && 'nativeEvent' in x ? '<event>' : x))]);
  };
/** log for a native call that answers later (with ''), or fails with `failing[name]` */
const failing: Record<string, unknown> = {};
const alog =
  (name: string) =>
  async (...a: any[]) => {
    log(name)(...a);
    if (failing[name] !== undefined) throw failing[name];
    return '';
  };
let env: any = null;
let forked: string | null = 'codex:fork';
let savedPath: string | null = '/saved.md';
/** what renameThread and saveText reject with, when set */
let renameFails: Error | null = null;
let saveFails: Error | null = null;
let resume: string | null = 'codex resume t1';

stubStore({
  useStore: store.useStore,
  setState: store.setState,
  nativeOf: (id: string) => id.split(':')[1],
  chatOf: (id: string) => id,
  navigate: (r: any) => store.setState({ route: r }),
  goBack: () => calls.push(['goBack']),
  goForward: () => calls.push(['goForward']),
  threadTitle: (t: any) => t?.title || t?.name || 'New chat',
  archiveThread: log('archive'),
  forkThread: async (id: string) => (calls.push(['fork', id]), forked),
  openSideChat: log('sideChat'),
  compactThread: log('compact'),
  toast: log('toast'),
  toastFailure: (what: string) => (e: any) => log('toast')(`${what}: ${e?.message ?? e}`, 'error'),
  openChanges: log('openChanges'),
  openPaneTab: log('openPaneTab'),
  ...tabMenuStoreExports(log),
  projectForThread: (t: any, projects: any[]) => projects.find((p) => p.id === t.projectId),
  renameThread: async (...a: any[]) => {
    log('rename')(...a);
    if (renameFails) throw renameFails;
  },
});
mock.module('../src/lib/environments.ts', {
  namedExports: { resolveEnvironment: async (root: string) => (calls.push(['readEnv', root]), { actions: [], ...env }) },
});
installNativeStub({
  win: { toggleMaximize: log('toggleMaximize'), open: alog('winOpen') },
  shell: { openPath: alog('openPath'), openIn: log('openIn') },
  app: { installed: async () => ({ finder: true, vscode: false, cursor: true, terminal: true }), icon: async () => null },
  dialog: {
    saveText: async (name: string, md: string) => {
      calls.push(['saveText', name, md]);
      if (saveFails) throw saveFails;
      return savedPath;
    },
  },
  clipboard: { write: alog('clipboard') },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
mock.module('../src/session/transcript.ts', {
  namedExports: {
    labelAt: (id: string, segs: any) => (n: number) => `${id}/${segs ? 'segs' : 'none'}/${n}`,
    transcriptMarkdown: (title: string, turns: any[], label: (n: number) => string) => `# ${title} (${turns.length} turns, ${label(0)})`,
  },
});
mock.module('../src/harness/types.ts', { namedExports: { cliSessionId: (id: string) => 'cli-' + id } });
mock.module('../src/harness/registry.ts', {
  namedExports: { resumeCommandFor: (nativeId: string) => (resume ? `${resume} (${nativeId})` : null) },
});
mock.module('../src/components/sidebar/Sidebar.tsx', { namedExports: { ThreadMenu: () => null } });
// its account tooltip is covered in sideChatTitleUI.test.ts
mock.module('../src/components/titleBar/SideChatTitle.tsx', {
  namedExports: { SideChatTitle: ({ threadId }: any) => createElement('span', { 'data-thread': threadId }, 'Side chat') },
});
// the account warning is its own hook (tests/sidebarFooterUI.test.ts); here only whether it is set matters
let attention = false;
mock.module('../src/session/profileAttention.ts', { namedExports: { useProfileAttention: () => attention } });
const { TitleBar } = await import('../src/components/titleBar/TitleBar.tsx');

const reset = (patch: any = {}) => {
  store.reset(initial(patch));
  calls.length = 0;
  env = null;
  forked = 'codex:fork';
  savedPath = '/saved.md';
  resume = 'codex resume t1';
};
const set = (patch: any) => act(async () => store.setState(patch));
const btn = (host: Element, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLElement;
const tip = (host: Element, label: string) => btn(host, label).parentElement!.getAttribute('data-tooltip');
const openMenu = async (host: Element) => {
  await click(btn(host, 'Chat actions'));
  return host.querySelector('[role=menu]')!;
};
const dbl = (el: Element) => act(async () => el.dispatchEvent(new (globalThis as any).window.MouseEvent('dblclick', { bubbles: true })));

test('an account needing attention marks the sidebar toggle only while the sidebar, and its account button, are hidden', async () => {
  for (const [open, warn, shown] of [
    [true, true, false],
    [false, false, false],
    [false, true, true],
  ] as const) {
    reset({ sidebarOpen: open });
    attention = warn;
    const { host, unmount } = await render(createElement(TitleBar));
    assert.equal(!!btn(host, 'Toggle sidebar').querySelector('.tb-attention'), shown, `open ${open}, attention ${warn}`);
    await unmount();
  }
  attention = false;
});

test('without a chat only the new-tab button shows on the right', async () => {
  reset({ route: { name: 'home' } });
  const { host, unmount } = await render(createElement(TitleBar));
  assert.ok(host.querySelector('.tb-title') === null);
  assert.ok(btn(host, 'Chat actions') === null);
  assert.ok(host.querySelector('[role=menu]') === null);
  await click(btn(host, 'New tab'));
  assert.deepEqual(calls, [['openPaneTab', 'browser']]);
  // a thread route whose chat is not loaded is treated the same
  await set({ route: { name: 'thread', id: 'codex:missing' } });
  assert.ok(host.querySelector('.tb-title') === null);
  await unmount();
});

test('the chat title opens its folder and renames on double-click: Enter commits a change, Escape and blanks do not', async () => {
  reset();
  const { host, unmount } = await render(createElement(TitleBar));
  assert.equal(host.querySelector('.tb-folder')!.parentElement!.getAttribute('data-tooltip'), '/work/app');
  await click(host.querySelector('.tb-folder'));
  assert.deepEqual(calls, [['openPath', '/work/app']]);
  calls.length = 0;
  const title = () => host.querySelector('.tb-title-text');
  const field = () => host.querySelector('.tb-rename') as HTMLInputElement;
  assert.equal(title()!.textContent, THREAD.title);
  const blur = () => act(async () => field().dispatchEvent(new (globalThis as any).window.FocusEvent('focusout', { bubbles: true })));
  for (const value of ['   ', THREAD.title]) {
    await dbl(title()!);
    assert.equal(field().defaultValue, THREAD.title);
    field().value = value;
    await blur();
    await flush();
    assert.ok(field() === null);
  }
  assert.deepEqual(calls, []);
  await dbl(title()!);
  await press(field(), 'Escape');
  assert.ok(field() === null);
  await dbl(title()!);
  field().value = '  Renamed  ';
  await press(field(), 'a');
  assert.ok(field());
  // Enter blurs the field (happy-dom fires the blur only for the focused element)
  field().focus();
  await press(field(), 'Enter');
  await flush();
  assert.ok(field() === null);
  assert.deepEqual(calls, [['rename', 'codex:t1', 'Renamed']]);
  // a rename the harness refuses says why
  calls.length = 0;
  renameFails = new Error('app-server is down');
  await dbl(title()!);
  field().value = 'Again';
  field().focus();
  await press(field(), 'Enter');
  await flush();
  renameFails = null;
  assert.deepEqual(calls, [
    ['rename', 'codex:t1', 'Again'],
    ['toast', 'Rename failed: app-server is down', 'error'],
  ]);
  await unmount();
});

test('chat controls: terminal toggle only with the pref, summary toggle, and the separator before new tab', async () => {
  reset();
  const { host, unmount } = await render(createElement(TitleBar));
  assert.ok(btn(host, 'Terminal') === null);
  assert.ok(host.querySelector('.tb-sep'));
  assert.equal(tip(host, 'Summary'), 'Show summary');
  await click(btn(host, 'Summary'));
  assert.equal(store.getState().summaryOpen, true);
  assert.equal(tip(host, 'Summary'), 'Hide summary');
  assert.ok(btn(host, 'Summary').classList.contains('active'));
  await set({ prefs: { bottomPanelControl: true } });
  assert.equal(tip(host, 'Terminal'), 'Show terminal');
  await click(btn(host, 'Terminal'));
  assert.equal(store.getState().bottomPanelOpen, true);
  assert.equal(tip(host, 'Terminal'), 'Hide terminal');
  assert.ok(btn(host, 'Terminal').classList.contains('active'));
  await unmount();
});

const TABS = [
  { id: 'c', kind: 'changes', title: 'x' },
  { id: 'fs', kind: 'files', title: 'x' },
  { id: 'f', kind: 'file', title: 'a.ts' },
  { id: 'sk', kind: 'skill', title: 'Skill' },
  { id: 'tm', kind: 'terminal', title: 'zsh' },
  { id: 'sa', kind: 'chat', readOnly: true, title: 'Explorer' },
  { id: 'sb', kind: 'chat', readOnly: true, title: '' },
  { id: 'sc', kind: 'chat', title: 'ignored' },
  { id: 'b1', kind: 'browser', title: 'Docs', url: 'https://docs' },
  { id: 'b2', kind: 'browser', title: '', url: 'about:blank' },
  { id: 'tasks', kind: 'tasks', title: '', threadId: 'codex:t1', views: [{ kind: 'agent', key: 'a1', title: 'Track A' }] },
];

test('with the right pane open the tab strip lists every tab kind, selects, closes and toggles full view', async () => {
  reset({ diffPanel: { open: true }, paneTabs: TABS, paneActive: 'f' });
  const { host, unmount } = await render(createElement(TitleBar));
  const strip = host.querySelector('.tb-tabs') as HTMLElement;
  assert.equal(strip.style.width, '400px');
  assert.ok(host.querySelector('.titlebar-main')!.classList.contains('beside-pane'));
  assert.equal((host.querySelector('.titlebar-main') as HTMLElement).style.right, '400px');
  assert.ok(host.querySelector('.tb-sep') === null);
  const tabs = () => [...strip.querySelectorAll('.tb-tab')];
  assert.deepEqual(
    tabs().map((t) => t.querySelector('span')!.textContent),
    ['Changes', 'Files', 'a.ts', 'Skill', 'zsh', 'Explorer', 'Sub-agent', 'Side chat', 'Docs', 'New tab', 'Tasks'],
  );
  assert.deepEqual(
    tabs().map((t) => t.querySelector('svg') !== null),
    TABS.map(() => true),
  );
  // the Background tasks tab wears Claude's task mark, the diamond
  assert.match(tabs()[10].querySelector('svg')!.getAttribute('class') ?? '', /diamond/);
  assert.equal(tabs()[8].getAttribute('title'), 'https://docs');
  assert.ok(tabs()[0].getAttribute('title') === null);
  assert.equal(strip.querySelector('.tb-tab.active span')!.textContent, 'a.ts');
  await click(tabs()[4]);
  assert.equal(store.getState().paneActive, 'tm');
  // Tab reaches every tab: Enter or Space selects it; a key on its close button is the button's own
  for (const tab of tabs()) assert.equal(tab.getAttribute('aria-label'), tab.querySelector('span')!.textContent);
  assert.deepEqual(
    tabs().map((t) => [t.getAttribute('role'), t.getAttribute('tabindex')]),
    TABS.map(() => ['button', '0']),
  );
  assert.equal(tabs()[4].getAttribute('aria-current'), 'true');
  assert.equal(tabs()[3].getAttribute('aria-current'), null);
  await press(tabs()[3], 'Enter');
  assert.equal(store.getState().paneActive, 'sk');
  await press(tabs()[4], ' ');
  assert.equal(store.getState().paneActive, 'tm');
  await press(tabs()[3].querySelector('.tb-tab-close'), 'Enter');
  assert.equal(store.getState().paneActive, 'tm');
  await click(tabs()[2].querySelector('.tb-tab-close'));
  assert.deepEqual(calls, [['closePaneTab', 'f']]);
  assert.equal(store.getState().paneActive, 'tm', 'closing does not select the tab');
  await click(btn(strip, 'New tab'));
  assert.deepEqual(calls.at(-1), ['openPaneTab', 'browser']);
  // full view hides the chat controls and adds a "back to chat" tab
  await click(btn(host, 'Enter full view'));
  assert.equal(store.getState().paneFull, true);
  assert.equal((host.querySelector('.titlebar-right') as HTMLElement).hidden, true);
  const chat = strip.querySelector('.chat-tab')!;
  assert.equal(chat.textContent, THREAD.title);
  await click(chat);
  assert.equal(store.getState().paneFull, false);
  await set({ paneFull: true });
  await press(strip.querySelector('.chat-tab'), 'Enter');
  assert.equal(store.getState().paneFull, false, 'Enter on the chat tab goes back to the chat');
  await set({ paneFull: true });
  await click(btn(host, 'Exit full view'));
  assert.equal(store.getState().paneFull, false);
  await set({ paneFull: true });
  await click(btn(host, 'Hide tabs'));
  assert.deepEqual(store.getState().diffPanel, { open: false });
  assert.equal(store.getState().paneFull, false);
  assert.ok(host.querySelector('.tb-tabs') === null);
  await unmount();
});

test('a tab opened while the strip shows grows in, a closed one shrinks away; tabs already there play nothing (#1511)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const docs = { id: 'b1', kind: 'browser', title: 'Docs', url: 'https://docs' };
    const more = { id: 'b3', kind: 'browser', title: 'More', url: 'https://more' };
    reset({ diffPanel: { open: true }, paneTabs: [docs], paneActive: 'b1' });
    const { host, unmount } = await render(createElement(TitleBar));
    const tab = (id: string) =>
      [...host.querySelectorAll('.tb-tabs .tb-tab')].find((t) => t.getAttribute('aria-label') === (id === 'b1' ? 'Docs' : 'More'));
    assert.equal(tab('b1')!.className.trim(), 'tb-tab active', 'there when the bar mounted: no entrance');
    await set({ paneTabs: [docs, more] });
    assert.match(tab('b3')!.className, /\btab-enter\b/);
    const closing = tab('b1')!;
    await set({ paneTabs: [more] });
    assert.equal(tab('b1'), closing, 'the same element shrinks away');
    assert.match(closing.className, /\btab-leaving\b/);
    assert.ok(closing.hasAttribute('inert'));
    await act(async () => mock.timers.tick(150));
    assert.equal(tab('b1'), undefined);
    // reduced motion: a closed tab goes at once
    const w = (globalThis as any).window;
    const before = w.matchMedia;
    w.matchMedia = () => ({ matches: true });
    try {
      await set({ paneTabs: [] });
      assert.equal(host.querySelectorAll('.tb-tabs .tb-tab').length, 0);
    } finally {
      w.matchMedia = before;
    }
    await unmount();
  } finally {
    mock.timers.reset();
  }
});

test('full view without a chat has no "back to chat" tab', async () => {
  reset({ route: { name: 'home' }, diffPanel: { open: true }, paneFull: true });
  const { host, unmount } = await render(createElement(TitleBar));
  assert.ok(host.querySelector('.chat-tab') === null);
  assert.ok(btn(host, 'Exit full view'));
  await unmount();
});

test('the chat menu: rename, pin/unpin, side chat, fork, scheduled task, move, new window, open in, archive', async () => {
  reset();
  const { host, unmount } = await render(createElement(TitleBar));
  const menu = await openMenu(host);
  assert.equal(menu.getAttribute('data-placement'), 'bottom-end');
  assert.ok(btn(host, 'Chat actions').classList.contains('active'));
  await click(byText(menu, 'Pin'));
  assert.deepEqual(store.getState().pinned, { 'codex:t1': true });
  await click(byText(menu, 'Unpin'));
  assert.deepEqual(store.getState().pinned, { 'codex:t1': false });
  await click(byText(menu, 'New side chat'));
  await click(byText(menu, 'Fork into new chat'));
  await click(byText(menu, 'Fork into new window'));
  forked = null;
  await click(byText(menu, 'Fork into new window'));
  await click(byText(menu, 'Move to right pane'));
  await click(byText(menu, 'Open in new window'));
  for (const app of menu.querySelectorAll('[data-submenu="Open in"] [role="menuitem"]')) await click(app);
  await click(byText(menu, 'Archive'));
  assert.deepEqual(calls, [
    ['readEnv', '/work/root'],
    ['sideChat', 'codex:t1'],
    ['fork', 'codex:t1'],
    ['fork', 'codex:t1'],
    ['winOpen', 'thread=codex%3Afork'],
    ['fork', 'codex:t1'],
    ['openChanges'],
    ['winOpen', 'thread=codex%3At1'],
    ['openIn', 'cursor', '/work/app'], // Open in, in the order shown: the preferred app first; VS Code is not installed
    ['openPath', '/work/app'],
    ['openIn', 'terminal', '/work/app'],
    ['archive', 'codex:t1'],
  ]);
  await click(byText(menu, 'Rename'));
  assert.ok(host.querySelector('.tb-rename'));
  const events: any[] = [];
  const w = (globalThis as any).window;
  const onTask = (e: any) => events.push(e.detail);
  w.addEventListener('new-scheduled-task', onTask);
  await click(byText(menu, 'Add scheduled task'));
  assert.deepEqual(store.getState().route, { name: 'scheduled' });
  await act(async () => new Promise((r) => setTimeout(r, 60)));
  w.removeEventListener('new-scheduled-task', onTask);
  assert.deepEqual(events, [{ threadId: 'codex:t1', cwd: '/work/app', name: THREAD.title }]);
  await unmount();
});

test('share saves the transcript under a safe file name; copy entries copy and confirm', async () => {
  reset({ runtime: { 'codex:t1': { turns: [{}, {}] } }, segments: { 'codex:t1': [{}] } });
  const { host, unmount } = await render(createElement(TitleBar));
  const menu = await openMenu(host);
  calls.length = 0;
  const md = '# Fix: the <bug>? (2 turns, codex:t1/segs/0)';
  await click(byText(menu, 'Share'));
  assert.deepEqual(calls, [
    ['saveText', 'Fix the bug.md', md],
    ['toast', 'Saved transcript'],
  ]);
  savedPath = null;
  calls.length = 0;
  await click(byText(menu, 'Share'));
  assert.deepEqual(calls, [['saveText', 'Fix the bug.md', md]]);
  // a file that can't be written says so
  calls.length = 0;
  saveFails = new Error('EACCES');
  await click(byText(menu, 'Share'));
  saveFails = null;
  assert.deepEqual(calls, [
    ['saveText', 'Fix the bug.md', md],
    ['toast', "Couldn't save the transcript: EACCES", 'error'],
  ]);
  calls.length = 0;
  const copy = menu.querySelector('[data-submenu="Copy"]')!;
  for (const label of ['Copy as Markdown', 'Copy chat ID', 'Copy resume command', 'Copy working directory'])
    await click(byText(copy, label));
  assert.deepEqual(calls, [
    ['clipboard', md],
    ['toast', 'Copied as Markdown'],
    ['clipboard', 'cli-codex:t1'],
    ['toast', 'Copied chat ID'],
    ['clipboard', 'codex resume t1 (t1)'],
    ['toast', 'Copied resume command'],
    ['clipboard', '/work/app'],
    ['toast', 'Copied path'],
  ]);
  // a harness without a resume command has no such entry; a chat without turns exports an empty transcript
  resume = null;
  await set({ runtime: {}, segments: {}, summaryOpen: true });
  assert.ok(maybeText(copy, 'Copy resume command') === null);
  calls.length = 0;
  await click(byText(copy, 'Copy as Markdown'));
  assert.deepEqual(calls[0], ['clipboard', '# Fix: the <bug>? (0 turns, codex:t1/none/0)']);
  await unmount();
});

test('project actions with a command appear under Actions and run in a terminal tab', async () => {
  reset();
  env = {
    actions: [
      { name: 'Run', command: 'npm start' },
      { name: 'Broken', command: '' },
    ],
  };
  const { host, unmount } = await render(createElement(TitleBar));
  const menu = await openMenu(host);
  const actions = menu.querySelector('[data-submenu="Actions"]')!;
  assert.deepEqual(
    [...actions.querySelectorAll('[role=menuitem]')].map((e) => e.textContent),
    ['Run'],
  );
  calls.length = 0;
  await click(byText(actions, 'Run'));
  assert.deepEqual(calls, [['openPaneTab', 'terminal', { cwd: '/work/app', title: 'Run', command: shellScript('npm start') }]]);
  await unmount();
});

test('the project root falls back to the chat folder; a project without actions shows no Actions menu', async () => {
  for (const [patch, root] of [
    [{ savedProjects: [{ id: 'p1', roots: [] }] }, '/work/app'],
    [{ savedProjects: [] }, '/work/app'],
  ] as const) {
    reset(patch);
    env = { actions: [] };
    const { host, unmount } = await render(createElement(TitleBar));
    const menu = await openMenu(host);
    assert.deepEqual(calls, [['readEnv', root]]);
    assert.ok(menu.querySelector('[data-submenu="Actions"]') === null);
    await unmount();
  }
  // no environment file at all
  reset();
  const { host, unmount } = await render(createElement(TitleBar));
  const menu = await openMenu(host);
  assert.ok(menu.querySelector('[data-submenu="Actions"]') === null);
  await click(host.querySelector('[data-menu-close]'));
  assert.ok(host.querySelector('[role=menu]') === null);
  await unmount();
});

browserTabMenuTests({ reset, set, TitleBar, calls, THREAD });
titleBarLayoutTests({ reset, set, TitleBar, calls, store });
