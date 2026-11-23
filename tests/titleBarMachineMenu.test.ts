// The title-bar menu of a chat on a machine has the same items and words as one of this Mac (M47, M49, M53): Copy resume command and Copy working directory say which machine they are for, Open in is greyed with the machine named, and nothing opens or runs on this Mac for the machine's folder.
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement } from 'react';
import { fakeStore, popoverExports, render, click, byText, maybeText } from './support/shell-chrome-kit.ts';
import { mockSource, shellPanels, stubStore } from './support/stubs.ts';
import { tabMenuStoreExports } from './support/titleBarTabMenu.ts';
import { installNativeStub } from './support/ports/native.ts';

type Chats = { owners: Map<string, string>; status: 'unknown' | 'ready' | 'failed'; answered: boolean };
const UUID = '7a1c0e52-3f0b-4f43-9d54-0d1f7f0e9a11';
const MACHINE_CHAT = `acp:host-claude:${UUID}`;
const STUDIO = { id: 'ssh:me@studio', name: 'Studio', status: 'online' };
let chats: Chats = { owners: new Map(), status: 'ready', answered: true };
mockSource('src/lib/hostChats.ts', {
  useHostChats: () => chats,
  machineOfChat: (c: Chats, id: string | null) => (!id ? '' : c.status === 'unknown' || !c.answered ? null : (c.owners.get(id) ?? '')),
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines: [STUDIO], resolved: true }) });

const calls: any[] = [];
const log =
  (name: string) =>
  (...a: any[]) =>
    void calls.push([name, ...a]);
const alog =
  (name: string) =>
  async (...a: any[]) => {
    log(name)(...a);
    return '';
  };
const initial = (route: string) => ({
  route: { name: 'thread', id: route },
  back: [],
  forward: [],
  ...shellPanels({ summaryOpen: false }),
  bottomPanelOpen: false,
  paneTabs: [],
  paneActive: null,
  paneFull: false,
  prefs: { bottomPanelControl: false, openDestination: 'cursor' },
  fullscreen: false,
  threads: {
    [MACHINE_CHAT]: { id: MACHINE_CHAT, title: 'On the box', cwd: '/srv/app', projectId: null },
    'claude:local': { id: 'claude:local', title: 'Here', cwd: '/work/app', projectId: null },
  },
  pinned: {},
  savedProjects: [],
  diffPanel: { open: false },
  paneWidth: 400,
  runtime: {},
  segments: {},
  chatConfig: {},
});
const store = fakeStore<any>(initial(MACHINE_CHAT));
stubStore({
  useStore: store.useStore,
  setState: store.setState,
  nativeOf: (id: string) => (id.startsWith('acp:') ? id : id.split(':')[1]),
  chatOf: (id: string) => id,
  navigate: (r: any) => store.setState({ route: r }),
  goBack: log('goBack'),
  goForward: log('goForward'),
  threadTitle: (t: any) => t.title,
  archiveThread: log('archive'),
  forkThread: async () => null,
  openSideChat: log('sideChat'),
  compactThread: log('compact'),
  toast: log('toast'),
  toastFailure: () => () => undefined,
  openChanges: log('openChanges'),
  openPaneTab: log('openPaneTab'),
  ...tabMenuStoreExports(log),
  projectForThread: () => undefined,
  renameThread: async () => undefined,
});
mock.module('../src/lib/environments.ts', {
  namedExports: {
    resolveEnvironment: async (root: string) => (calls.push(['readEnv', root]), { actions: [{ name: 'Dev', command: 'npm run dev' }] }),
  },
});
installNativeStub({
  win: { toggleMaximize: log('toggleMaximize'), open: alog('winOpen') },
  shell: { openPath: alog('openPath'), openIn: log('openIn') },
  app: { installed: async () => ({ finder: true, cursor: true }), icon: async () => null },
  dialog: { saveText: async () => null },
  clipboard: { write: alog('clipboard') },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
mock.module('../src/session/transcript.ts', {
  namedExports: { labelAt: () => () => '', transcriptMarkdown: () => '# chat' },
});
mock.module('../src/harness/types.ts', { namedExports: { cliSessionId: (id: string) => id.split(':').slice(2).join(':') || 'cli-' + id } });
mock.module('../src/harness/registry.ts', {
  namedExports: {
    resumeCommandFor: (nativeId: string) => (nativeId.startsWith('acp:host-claude:') ? `claude --resume ${UUID}` : 'codex resume local'),
  },
});
mock.module('../src/components/sidebar/Sidebar.tsx', { namedExports: { ThreadMenu: () => null } });
mock.module('../src/components/titleBar/SideChatTitle.tsx', { namedExports: { SideChatTitle: () => null } });
mock.module('../src/session/profileAttention.ts', { namedExports: { useProfileAttention: () => false } });
const { TitleBar } = await import('../src/components/titleBar/TitleBar.tsx');

const onStudio = () => (chats = { owners: new Map([[MACHINE_CHAT, STUDIO.id]]), status: 'ready', answered: true });
const open = async (route: string) => {
  store.reset(initial(route));
  const view = await render(createElement(TitleBar));
  await click(view.host.querySelector('button[aria-label="Chat actions"]'));
  return { ...view, menu: view.host.querySelector('[role=menu]') as HTMLElement };
};
const COPY = ['Copy as Markdown', 'Copy chat ID', 'Copy resume command', 'Copy working directory'];

beforeEach(() => {
  chats = { owners: new Map(), status: 'ready', answered: true };
  calls.length = 0;
});

test('a chat on a machine has the same Copy items, and the machine-bound ones name the machine', async () => {
  onStudio();
  const { menu, unmount } = await open(MACHINE_CHAT);
  const copy = menu.querySelector('[data-submenu="Copy"]') as HTMLElement;
  assert.deepEqual(
    COPY.map((label) => maybeText(copy, label) !== null),
    [true, true, true, true],
  );
  // the real session uuid and the machine's own path, with the machine said where the command or path is good
  assert.equal(byText(copy, 'Copy resume command').querySelector('.menu-hint')?.textContent, 'On Studio');
  assert.equal(byText(copy, 'Copy working directory').querySelector('.menu-hint')?.textContent, 'On Studio');
  assert.equal(byText(copy, 'Copy chat ID').querySelector('.menu-hint'), null);
  calls.length = 0;
  for (const label of ['Copy chat ID', 'Copy resume command', 'Copy working directory']) await click(byText(copy, label));
  assert.deepEqual(calls, [
    ['clipboard', UUID],
    ['toast', 'Copied chat ID'],
    ['clipboard', `claude --resume ${UUID}`],
    ['toast', 'Copied resume command: run it on Studio'],
    ['clipboard', '/srv/app'],
    ['toast', 'Copied path on Studio'],
  ]);
  await unmount();
});

test('a chat of this Mac keeps the plain words and no machine hint', async () => {
  const { menu, unmount } = await open('claude:local');
  const copy = menu.querySelector('[data-submenu="Copy"]') as HTMLElement;
  assert.equal(copy.querySelector('.menu-hint'), null);
  calls.length = 0;
  await click(byText(copy, 'Copy working directory'));
  assert.deepEqual(calls, [
    ['clipboard', '/work/app'],
    ['toast', 'Copied path'],
  ]);
  await unmount();
});

test('the session title shows its resolved execution location and keeps Finder for a local folder', async () => {
  chats.status = 'unknown';
  store.reset(initial(MACHINE_CHAT));
  const view = await render(createElement(TitleBar));
  const title = () => view.host.querySelector('.tb-title')!;
  try {
    assert.equal(title().querySelector('.tb-folder, .host-mark'), null, 'unresolved ownership cannot offer Finder');
    onStudio();
    await view.rerender(createElement(TitleBar));
    assert.ok(title().querySelector('.host-mark[aria-label="On Studio"] .lucide-square-terminal'));
    assert.equal(title().querySelector('button'), null);

    chats.owners.set(MACHINE_CHAT, 'this-mac-host');
    await view.rerender(createElement(TitleBar));
    assert.ok(title().querySelector('.host-mark .lucide-laptop'));

    await act(async () => store.setState({ route: { name: 'thread', id: 'claude:local' } }));
    assert.equal(title().querySelector('.host-mark'), null);
    await click(title().querySelector('.tb-folder'));
    assert.deepEqual(calls, [['openPath', '/work/app']]);
  } finally {
    await view.unmount();
  }
});

test('a machine chat that moved to another agent has no resume command: its id is the first agent', async () => {
  onStudio();
  store.reset({ ...initial(MACHINE_CHAT), chatConfig: { [MACHINE_CHAT]: { hostAgent: 'codex' } } });
  const view = await render(createElement(TitleBar));
  await click(view.host.querySelector('button[aria-label="Chat actions"]'));
  const copy = view.host.querySelector('[data-submenu="Copy"]') as HTMLElement;
  assert.equal(maybeText(copy, 'Copy resume command'), null);
  assert.ok(maybeText(copy, 'Copy chat ID'));
  await view.unmount();
});

test('Open in is one greyed item naming the machine, and nothing opens or runs on this Mac for its folder', async () => {
  onStudio();
  const { menu, unmount } = await open(MACHINE_CHAT);
  const submenu = menu.querySelector('[data-submenu="Open in"]') as HTMLElement;
  const folder = byText(submenu, 'Open folder') as HTMLButtonElement;
  assert.equal(folder.disabled, true);
  assert.equal(folder.querySelector('.menu-hint')?.textContent, 'On Studio');
  assert.equal(folder.title, 'This folder is on Studio, not on this Mac');
  assert.equal(maybeText(submenu, 'Cursor'), null);
  await click(folder);
  // Project actions need a folder on this Mac: none for a machine's (by design, M49)
  assert.equal(maybeText(menu, 'Dev'), null);
  assert.deepEqual(
    calls.filter(([name]) => ['openIn', 'openPath', 'readEnv', 'openPaneTab'].includes(name)),
    [],
  );
  await unmount();
});

test('Open in on this Mac lists the apps and no greyed folder item', async () => {
  const { menu, unmount } = await open('claude:local');
  const submenu = menu.querySelector('[data-submenu="Open in"]') as HTMLElement;
  assert.ok(maybeText(submenu, 'Cursor'));
  assert.equal(maybeText(submenu, 'Open folder'), null);
  await unmount();
});
